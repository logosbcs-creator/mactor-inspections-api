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
      const analysisContext = Object.values(inspection.aiAnalysis || {})
        .map(a => a.inspector_note).filter(Boolean).join(' | ');

      if (isNewProject && inspection.problemDescription) {
        console.log(`[Approve] Generating project estimate for inspection ${inspection.id}`);
        aiEstimate = await generateEstimateFromDescription(
          inspection.problemDescription,
          analysisContext,
          inspection.propertyType
        );
      } else if (!isNewProject) {
        const defects = inspection.aiSummary?.all_defects || [];
        if (defects.length > 0) {
          console.log(`[Approve] Generating estimate for inspection ${inspection.id}, ${defects.length} defects`);
          aiEstimate = await generateEstimate(defects, inspection.propertyType);
        } else if (inspection.problemDescription) {
          console.log(`[Approve] Generating description-based estimate for inspection ${inspection.id}`);
          aiEstimate = await generateEstimateFromDescription(
            inspection.problemDescription,
            analysisContext,
            inspection.propertyType
          );
        } else {
          console.log(`[Approve] No description and no defects for inspection ${inspection.id} — skipping estimate`);
        }
      }

      if (aiEstimate?.recommended?.line_items?.length > 0) {
        await prisma.inspection.update({
          where: { id: inspection.id },
          data: { aiEstimate },
        });
      }
    } catch (err) {
      console.error(`[Approve] Estimate generation failed for inspection ${inspection.id}:`, err?.message);
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
  await sendEstimateToClient(updated);

  res.json({ success: true, message: 'Estimate sent to client.' });
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
