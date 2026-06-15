const express = require('express');
const prisma  = require('../services/database');
const { generateEstimate, generateEstimateFromDescription } = require('../services/pricing');
const { sendEstimateToClient }  = require('../services/email');

const router = express.Router();

// GET /api/approve/:token — MacTor approval page data
router.get('/:token', async (req, res) => {
  const inspection = await prisma.inspection.findUnique({
    where: { approvalToken: req.params.token },
  });
  if (!inspection) return res.status(404).json({ error: 'Invalid or expired token' });

  // Auto-generate AI estimate if not yet done (or if previous attempt failed)
  let aiEstimate = inspection.aiEstimate;
  const hasValidEstimate = aiEstimate?.recommended?.line_items?.length > 0;
  const isNewProject = inspection.serviceType === 'new_project';

  if (!hasValidEstimate) {
    try {
      // For new_project: pass full site observations so pricing AI sees everything Claude saw
      let analysisContext;
      if (isNewProject) {
        const siteObs = Object.values(inspection.aiAnalysis || {})
          .flatMap(a => a.site_observations || [])
          .map(obs => `- ${obs.aspect}: ${obs.detail} → ${obs.project_relevance}`)
          .join('\n');
        const notes = Object.values(inspection.aiAnalysis || {})
          .map(a => a.inspector_note).filter(Boolean).join(' | ');
        analysisContext = [siteObs, notes].filter(Boolean).join('\n');
      } else {
        analysisContext = Object.values(inspection.aiAnalysis || {})
          .map(a => a.inspector_note).filter(Boolean).join(' | ');
      }

      if (inspection.problemDescription) {
        // Always base the estimate on what the client asked for.
        // Photo observations are context only (sizing, materials, conditions) — not separate line items.
        if (!isNewProject) {
          const siteNotes = Object.values(inspection.aiAnalysis || {})
            .flatMap(a => (a.observed_defects || []))
            .map(d => `- ${d.defect_type} (${d.location}): ${d.danger_if_ignored}`)
            .join('\n');
          const inspectorNotes = Object.values(inspection.aiAnalysis || {})
            .map(a => a.inspector_note).filter(Boolean).join(' | ');
          analysisContext = [siteNotes, inspectorNotes].filter(Boolean).join('\n');
        }
        console.log(`[Approve] Generating estimate for inspection ${inspection.id}`);
        aiEstimate = await generateEstimateFromDescription(
          inspection.problemDescription,
          analysisContext,
          inspection.propertyType
        );
      } else {
        console.log(`[Approve] No client description for inspection ${inspection.id} — skipping estimate`);
      }

      if (aiEstimate?.recommended?.line_items?.length > 0) {
        await prisma.inspection.update({
          where: { id: inspection.id },
          data: { aiEstimate },
        });
      }
    } catch (err) {
      console.error(`[Approve] Estimate generation failed for inspection ${inspection.id}:`, err?.message, err?.stack);
    }
  }

  res.json({ ...inspection, aiEstimate });
});

// POST /api/approve/:token — submit approval with modifications
router.post('/:token', async (req, res) => {
  const { approvedEstimate, approvalNotes, lineItemNotes } = req.body;

  const inspection = await prisma.inspection.findUnique({
    where: { approvalToken: req.params.token },
  });
  if (!inspection) return res.status(404).json({ error: 'Invalid token' });

  // Save approved estimate
  const updated = await prisma.inspection.update({
    where: { id: inspection.id },
    data: {
      approvedEstimate,
      approvalNotes,
      status: 'estimate_sent',
      approvedAt: new Date(),
      estimateSentAt: new Date(),
    },
  });

  // Save training data for each line item that was modified
  const aiItems = inspection.aiEstimate?.recommended?.line_items || [];
  const approvedItems = approvedEstimate?.line_items || [];

  for (const approved of approvedItems) {
    const original = aiItems.find(i => i.defect_type === approved.defect_type);
    if (original) {
      await prisma.trainingData.create({
        data: {
          inspectionId:       inspection.id,
          propertyType:       inspection.propertyType,
          damageType:         approved.defect_type,
          aiPriceSuggested:   original.total,
          julioApprovedPrice: approved.total,
          julioNote:          lineItemNotes?.[approved.defect_type] || null,
        },
      }).catch(() => {}); // non-critical
    }
  }

  // Send estimate email to client
  try {
    await sendEstimateToClient(updated);
    res.json({ success: true, message: 'Estimate sent to client.' });
  } catch (emailErr) {
    console.error('[Approve] Email send failed:', emailErr.message);
    res.json({ success: true, emailError: emailErr.message, message: 'Estimate saved but email failed — check SMTP credentials.' });
  }
});

// POST /api/approve/:token/accept — client accepts estimate
router.post('/:token/accept', async (req, res) => {
  const { sendAcceptanceToMacTor } = require('../services/email');

  const inspection = await prisma.inspection.findUnique({
    where: { acceptToken: req.params.token },
  });
  if (!inspection) return res.status(404).json({ error: 'Invalid token' });
  if (inspection.status === 'accepted') return res.json({ success: true, alreadyAccepted: true });

  const updated = await prisma.inspection.update({
    where: { id: inspection.id },
    data: { status: 'accepted', acceptedAt: new Date() },
  });

  sendAcceptanceToMacTor(updated).catch(console.error);

  res.json({ success: true });
});

// POST /api/approve/:token/decline — client declines estimate
router.post('/:token/decline', async (req, res) => {
  const inspection = await prisma.inspection.findUnique({
    where: { acceptToken: req.params.token },
  });
  if (!inspection) return res.status(404).json({ error: 'Invalid token' });

  await prisma.inspection.update({
    where: { id: inspection.id },
    data: { status: 'declined' },
  });

  res.json({ success: true });
});

module.exports = router;
