const express = require('express');
const multer  = require('multer');
const prisma  = require('../services/database');
const { uploadPhoto }            = require('../services/cloudinary');
const { analyzePhoto }           = require('../services/claudeVision');
const { sendInspectionToMacTor } = require('../services/email');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

const VALID_LANGS       = ['en', 'es', 'zh', 'hi', 'tl'];
const VALID_CATEGORIES  = ['plumbing','electrical','structural','hvac','roofing','water_damage','pests','doors_windows','exterior','other'];

// POST /api/inspection — create empty inspection
router.post('/', async (req, res) => {
  const { propertyType, clientLanguage, serviceType } = req.body;
  if (!propertyType) return res.status(400).json({ error: 'propertyType required' });

  const lang = VALID_LANGS.includes(clientLanguage) ? clientLanguage : 'en';
  const svc  = ['repair', 'new_project'].includes(serviceType) ? serviceType : 'repair';

  const inspection = await prisma.inspection.create({
    data: { propertyType, clientLanguage: lang, serviceType: svc },
  });

  res.json({ success: true, id: inspection.id });
});

// PATCH /api/inspection/:id/context — save description, category, and service type
router.patch('/:id/context', async (req, res) => {
  const { id } = req.params;
  const { problemDescription, issueCategory, serviceType } = req.body;

  const inspection = await prisma.inspection.findUnique({ where: { id } });
  if (!inspection) return res.status(404).json({ error: 'Inspection not found' });

  const VALID_SERVICE_TYPES = ['repair', 'renovation', 'new_project'];
  const cat = VALID_CATEGORIES.includes(issueCategory) ? issueCategory : 'other';
  const svc = VALID_SERVICE_TYPES.includes(serviceType) ? serviceType : 'repair';

  const updated = await prisma.inspection.update({
    where: { id },
    data: {
      problemDescription: (problemDescription || '').trim().slice(0, 500),
      issueCategory: cat,
      serviceType: svc,
    },
  });

  res.json({ success: true, issueCategory: updated.issueCategory, serviceType: updated.serviceType });
});

// POST /api/inspection/:id/photo — upload + analyze one photo
router.post('/:id/photo', upload.single('photo'), async (req, res) => {
  const { id } = req.params;

  const inspection = await prisma.inspection.findUnique({ where: { id } });
  if (!inspection) return res.status(404).json({ error: 'Inspection not found' });
  if ((inspection.photos || []).length >= 10) return res.status(400).json({ error: 'Maximum 10 photos reached' });
  if (!req.file) return res.status(400).json({ error: 'No photo provided' });

  // Upload to Cloudinary
  const cloudResult = await uploadPhoto(req.file.buffer, req.file.originalname);
  const photoUrl = cloudResult.secure_url;

  // Analyze with Inspector MacTor (context-aware if description/category exist)
  const base64 = req.file.buffer.toString('base64');
  const analysis = await analyzePhoto(
    base64,
    req.file.mimetype,
    inspection.issueCategory,
    inspection.problemDescription,
  );

  // Parse EXIF coords from request if provided
  const exifCoords = req.body.exifCoords ? JSON.parse(req.body.exifCoords) : null;

  // Update inspection
  const currentPhotos   = inspection.photos   || [];
  const currentAnalysis = inspection.aiAnalysis || {};

  const updatedInspection = await prisma.inspection.update({
    where: { id },
    data: {
      photos:     [...currentPhotos, photoUrl],
      aiAnalysis: { ...currentAnalysis, [photoUrl]: analysis },
      ...(exifCoords && !inspection.exifCoords ? { exifCoords } : {}),
    },
  });

  res.json({ success: true, photoUrl, analysis, totalPhotos: updatedInspection.photos.length });
});

// POST /api/inspection/:id/submit — finalize with client info + follow-up answers
router.post('/:id/submit', async (req, res) => {
  const { id } = req.params;
  const { clientName, clientEmail, clientPhone, address, clientLanguage, followUpAnswers } = req.body;

  const inspection = await prisma.inspection.findUnique({ where: { id } });
  if (!inspection) return res.status(404).json({ error: 'Inspection not found' });

  // Aggregate AI analysis
  const analyses  = Object.values(inspection.aiAnalysis || {});
  const allDefects = analyses.flatMap(a => (a.observed_defects || []).map(d => ({ ...d, area: a.area_detected })));

  const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1, no_issues: 0 };
  const topPriority = allDefects.reduce((best, d) =>
    (priorityOrder[d.severity] || 0) > (priorityOrder[best] || 0) ? d.severity : best
  , 'no_issues');

  const aiSummary = {
    total_photos:   (inspection.photos || []).length,
    total_defects:  allDefects.length,
    all_defects:    allDefects,
    top_priority:   topPriority,
    areas_affected: [...new Set(allDefects.map(d => d.area).filter(Boolean))],
    danger_alerts:  allDefects
      .filter(d => d.severity === 'high' || d.severity === 'critical')
      .map(d => ({ defect: d.defect_type, danger: d.danger_if_ignored })),
    problem_description: inspection.problemDescription,
    issue_category:      inspection.issueCategory,
  };

  const lang = VALID_LANGS.includes(clientLanguage) ? clientLanguage : inspection.clientLanguage || 'en';

  // Parse follow-up answers
  let parsedFollowUp = null;
  if (followUpAnswers && Array.isArray(followUpAnswers)) {
    parsedFollowUp = followUpAnswers.filter(a => a.answer && a.answer.trim());
  }

  const updated = await prisma.inspection.update({
    where: { id },
    data: {
      clientName, clientEmail, clientPhone, address,
      clientLanguage: lang,
      followUpAnswers: parsedFollowUp,
      aiSummary,
      status: 'pending_approval',
    },
  });

  sendInspectionToMacTor(updated).catch(err =>
    console.error('Email to MacTor failed:', err.message)
  );

  res.json({ success: true, summary: aiSummary });
});

// GET /api/inspection/:id — get inspection data
router.get('/:id', async (req, res) => {
  const inspection = await prisma.inspection.findUnique({ where: { id: req.params.id } });
  if (!inspection) return res.status(404).json({ error: 'Not found' });
  res.json(inspection);
});

module.exports = router;
