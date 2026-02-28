import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { Server } from 'socket.io';
import { createServer } from 'http';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('uploads'));

// Store active exam sessions and connections
const activeSessions = new Map();
const pendingVerifications = new Map();
const socketToSession = new Map();
const teacherSockets = new Set();
let sessionSequence = 0;
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// AI Service URLs
const AI_SERVICES = {
  PRE_EXAM: 'http://localhost:8000',
  MONITORING: 'http://localhost:8001',
  FLAGGING: 'http://localhost:8002',
  AUDIT: 'http://localhost:8003'
};

// ElevenLabs Text-to-Speech (server-side so API key stays private)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.VERTEX_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const safePercent = (value) => {
  if (!Number.isFinite(value)) return '0.0';
  return (value * 100).toFixed(1);
};

const getVerificationKey = (candidateId = '', examId = '') => `${candidateId}::${examId}`;

const RATE_LIMITS = {
  TTS: { windowMs: 60 * 1000, max: 20 },
  ASSISTANT: { windowMs: 60 * 1000, max: 12 }
};

const CACHE_TTLS = {
  TTS: 10 * 60 * 1000,
  ASSISTANT: 2 * 60 * 1000
};

const CACHE_MAX_ITEMS = {
  TTS: 120,
  ASSISTANT: 300
};

const SESSION_MEMORY_LIMITS = {
  warnings: 500,
  anomalies: 500,
  comfortRequests: 100
};

const ENDED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const PENDING_VERIFICATION_RETENTION_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const ttsRateBuckets = new Map();
const assistantRateBuckets = new Map();
const ttsCache = new Map();
const assistantCache = new Map();

const getClientKey = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
};

const normalizeTextForKey = (value = '') => String(value).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 600);

const isRateLimited = (bucket, key, windowMs, max) => {
  const now = Date.now();
  const history = bucket.get(key) || [];
  const filtered = history.filter(ts => now - ts < windowMs);
  if (filtered.length >= max) {
    bucket.set(key, filtered);
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - filtered[0])) / 1000)) };
  }
  filtered.push(now);
  bucket.set(key, filtered);
  return { limited: false, retryAfterSec: 0 };
};

const getCacheValue = (cacheMap, key) => {
  const now = Date.now();
  const cached = cacheMap.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    cacheMap.delete(key);
    return null;
  }
  return cached.value;
};

const setCacheValue = (cacheMap, key, value, ttlMs, maxEntries) => {
  cacheMap.set(key, { value, expiresAt: Date.now() + ttlMs, createdAt: Date.now() });
  if (cacheMap.size <= maxEntries) return;
  const entries = Array.from(cacheMap.entries()).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  const removeCount = cacheMap.size - maxEntries;
  for (let i = 0; i < removeCount; i++) {
    cacheMap.delete(entries[i][0]);
  }
};

const capArray = (arr, maxLength) => {
  if (!Array.isArray(arr)) return;
  if (arr.length <= maxLength) return;
  arr.splice(0, arr.length - maxLength);
};

const cleanupRateBucket = (bucket, windowMs) => {
  const now = Date.now();
  for (const [key, timestamps] of bucket.entries()) {
    const filtered = timestamps.filter(ts => now - ts < windowMs);
    if (filtered.length > 0) bucket.set(key, filtered);
    else bucket.delete(key);
  }
};

const cleanupCache = (cacheMap, maxEntries) => {
  const now = Date.now();
  for (const [key, entry] of cacheMap.entries()) {
    if (!entry || entry.expiresAt <= now) cacheMap.delete(key);
  }
  if (cacheMap.size <= maxEntries) return;
  const entries = Array.from(cacheMap.entries()).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  const removeCount = cacheMap.size - maxEntries;
  for (let i = 0; i < removeCount; i++) {
    cacheMap.delete(entries[i][0]);
  }
};

const buildAssistantFallbackReply = (message, context = {}) => {
  const msg = String(message || '').toLowerCase();
  const severity = context.severity || 'OK';
  const activeSignals = Array.isArray(context.activeSignals) ? context.activeSignals : [];

  if (/(stop|leave|quit|end exam|exit)/i.test(msg)) {
    return [
      'To stop safely: 1) Click End Meeting in the right panel.',
      '2) Stay visible until the meeting closes.',
      '3) Inform the host/proctor immediately about the reason.',
      '4) Do not close the browser abruptly to avoid report/recording loss.'
    ].join(' ');
  }

  if (/(camera|video|webcam|face)/i.test(msg)) {
    return [
      'Camera troubleshooting: 1) Allow camera permission in browser.',
      '2) Close other apps using camera (Zoom/Meet/Teams).',
      '3) Click Retry camera or reload meeting once.',
      '4) Keep your face centered and well-lit.'
    ].join(' ');
  }

  if (/(audio|voice|sound|mic|speaker)/i.test(msg)) {
    return [
      'Audio troubleshooting: 1) Unmute browser tab and system volume.',
      '2) Enable site sound permissions.',
      '3) Keep Voice Replies ON in DIGICLASS bot panel.',
      '4) Rejoin meeting if audio devices changed.'
    ].join(' ');
  }

  if (/(tab|switch|copilot|ai tool|chatgpt|shortcut|paste)/i.test(msg)) {
    return [
      'Exam integrity warning: do not switch tabs, open AI tools, or paste external content.',
      'Keep focus on DIGICLASS exam window to avoid violations and auto-recording.'
    ].join(' ');
  }

  return [
    'DIGICLASS Support is active.',
    `Current status: ${severity}${activeSignals.length ? ` with signals ${activeSignals.join(', ')}` : ''}.`,
    'For help, tell me if you need: stop exam steps, camera fix, audio fix, or verification guidance.'
  ].join(' ');
};

const buildTeacherSummary = (session) => {
  const averageRisk = session.frameCount > 0 ? (session.totalRiskAccum / session.frameCount) : 0;
  const verification = session.verification || {};
  const verificationEvidence = session.verificationEvidence || null;
  return {
    sessionId: session.sessionId,
    sessionNumber: session.sessionNumber || null,
    candidateId: session.candidateId,
    studentId: session.candidateId,
    studentName: session.candidateId,
    examId: session.examId,
    status: session.endTime ? 'Ended' : 'Active',
    timestamp: session.lastAnalysisAt || session.startTime,
    reason: session.lastReason || (session.finalAiAnalysis?.aiInsight || 'No alerts yet'),
    riskScore: session.latestRiskScore || 0,
    severity: session.latestSeverity || 'OK',
    signals: session.latestSignals || [],
    violationCount: session.violationCount || 0,
    warningsRaised: session.warnings.length,
    averageRiskPercent: safePercent(averageRisk),
    peakRiskPercent: safePercent(session.peakRisk || 0),
    finalAiInsight: session.finalAiAnalysis?.aiInsight || session.latestAiInsight || null,
    finalAiAnalysis: session.finalAiAnalysis || null,
    recordingActive: !!session.recordingActive,
    recordingStartedAt: session.recordingStartedAt || null,
    recordingSavedAt: session.recordingSavedAt || null,
    videoUrl: session.videoUrl || null,
    comfortRequests: session.comfortRequests || [],
    warningsTail: Array.isArray(session.warnings) ? session.warnings.slice(-20) : [],
    verificationEvidence,
    verification: {
      faceVerified: !!verification.faceVerified,
      idVerified: !!verification.idVerified,
      envScanPassed: !!verification.envScanPassed
    },
    startTime: session.startTime,
    endTime: session.endTime || null
  };
};

const broadcastActiveSessions = () => {
  io.to('teachers').emit('active-sessions', {
    sessions: Array.from(activeSessions.values()).map(buildTeacherSummary)
  });
};

// ───────────────────────────────────────────
// REST ENDPOINTS
// ───────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'AI Proctored Exam Backend — MediaPipe Edition',
    timestamp: new Date().toISOString(),
    detectionEngine: 'Google MediaPipe (browser-side)',
    activeSessions: activeSessions.size,
    connectedTeachers: teacherSockets.size,
  });
});

// Log frontend errors
app.post('/log-error', (req, res) => {
  const { error, details, candidateId, sessionId } = req.body;
  console.error(`[FRONTEND ERROR] Student: ${candidateId || 'Unknown'} | Session: ${sessionId || 'None'}`);
  console.error(`Error: ${error}`);
  if (details) console.error(`Details: ${JSON.stringify(details, null, 2)}`);
  res.json({ success: true });
});

// Text-to-Speech proxy (ElevenLabs)
app.post('/tts', async (req, res) => {
  try {
    const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
    const text = rawText.trim().slice(0, 400);
    if (!text) return res.status(400).json({ error: 'Missing text' });
    const clientKey = getClientKey(req);
    const rateCheck = isRateLimited(ttsRateBuckets, clientKey, RATE_LIMITS.TTS.windowMs, RATE_LIMITS.TTS.max);
    if (rateCheck.limited) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
      return res.status(429).json({ error: 'TTS rate limit exceeded. Please retry shortly.' });
    }

    const cacheKey = normalizeTextForKey(text);
    const cachedAudio = getCacheValue(ttsCache, cacheKey);
    if (cachedAudio) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Cache', 'HIT');
      return res.send(Buffer.from(cachedAudio));
    }

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      return res.status(503).json({ error: 'TTS not configured' });
    }

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: { stability: 0.35, similarity_boost: 0.85 }
      },
      {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY
        }
      }
    );

    const audioBuffer = Buffer.from(response.data);
    setCacheValue(ttsCache, cacheKey, audioBuffer, CACHE_TTLS.TTS, CACHE_MAX_ITEMS.TTS);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Cache', 'MISS');
    return res.send(audioBuffer);
  } catch (error) {
    console.error('[TTS ERROR]', error.response?.status || '', error.message);
    return res.status(502).json({ error: 'TTS failed' });
  }
});

// DIGICLASS support chatbot (Gemini/Vertex API key via env)
app.post('/assistant/chat', async (req, res) => {
  try {
    const rawMessage = typeof req.body?.message === 'string' ? req.body.message : '';
    const message = rawMessage.trim().slice(0, 1200);
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
    const session = sessionId ? activeSessions.get(sessionId) : null;
    const candidateId = (typeof req.body?.candidateId === 'string' ? req.body.candidateId : '') || session?.candidateId || 'Student';
    const examId = (typeof req.body?.examId === 'string' ? req.body.examId : '') || session?.examId || 'Unknown';
    const metrics = req.body?.metrics || {};
    const severity = typeof metrics?.severity === 'string' ? metrics.severity : (session?.latestSeverity || 'OK');
    const riskScore = Number.isFinite(Number(metrics?.riskScore)) ? Number(metrics.riskScore) : Number(session?.latestRiskScore || 0);
    const activeSignals = Array.isArray(metrics?.signals) ? metrics.signals.slice(0, 6) : (session?.latestSignals || []).slice(0, 6);
    const fallbackReply = buildAssistantFallbackReply(message, { severity, activeSignals });
    const clientKey = `${getClientKey(req)}::${candidateId || 'anon'}`;
    const rateCheck = isRateLimited(assistantRateBuckets, clientKey, RATE_LIMITS.ASSISTANT.windowMs, RATE_LIMITS.ASSISTANT.max);
    if (rateCheck.limited) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSec));
      return res.status(429).json({ error: 'Assistant rate limit exceeded. Please retry shortly.' });
    }
    const assistantCacheKey = JSON.stringify({
      message: normalizeTextForKey(message),
      candidateId: normalizeTextForKey(candidateId),
      examId: normalizeTextForKey(examId),
      severity,
      signals: activeSignals.join(',')
    });
    const cachedReply = getCacheValue(assistantCache, assistantCacheKey);
    if (cachedReply) {
      return res.json({
        ...cachedReply,
        cached: true,
        source: `cache-${cachedReply.source}`
      });
    }

    if (!GEMINI_API_KEY) {
      const payload = {
        reply: fallbackReply,
        source: 'fallback',
        timestamp: new Date().toISOString()
      };
      setCacheValue(assistantCache, assistantCacheKey, payload, CACHE_TTLS.ASSISTANT, CACHE_MAX_ITEMS.ASSISTANT);
      return res.json(payload);
    }

    const systemPrompt = [
      'You are DIGICLASS AI Support Assistant for a live proctored exam platform.',
      'Your job is only platform support and wellbeing help.',
      'Do NOT solve exam questions or provide academic answers.',
      'If user wants to stop/leave exam, tell them to use End Meeting and inform proctor/host.',
      'If user has technical issue, give concise step-by-step troubleshooting.',
      'Keep replies short, professional, and actionable.'
    ].join(' ');

    const contextPrompt = [
      `Candidate: ${candidateId}`,
      `Exam ID: ${examId}`,
      `Session ID: ${sessionId || 'N/A'}`,
      `Current severity: ${severity}`,
      `Current risk score: ${safePercent(riskScore)}`,
      `Active signals: ${activeSignals.length ? activeSignals.join(', ') : 'None'}`
    ].join('\n');

    const contents = [
      { role: 'user', parts: [{ text: `${systemPrompt}\n\nContext:\n${contextPrompt}` }] }
    ];

    history.forEach((entry) => {
      if (!entry || typeof entry.text !== 'string') return;
      const text = entry.text.trim().slice(0, 800);
      if (!text) return;
      contents.push({
        role: entry.role === 'assistant' ? 'model' : 'user',
        parts: [{ text }]
      });
    });

    contents.push({ role: 'user', parts: [{ text: message }] });

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents,
        generationConfig: {
          temperature: 0.35,
          topP: 0.8,
          maxOutputTokens: 350
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000
      }
    );

    const reply = response?.data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || '')
      .join(' ')
      .trim();

    if (!reply) {
      const payload = {
        reply: fallbackReply,
        source: 'fallback-empty',
        timestamp: new Date().toISOString()
      };
      setCacheValue(assistantCache, assistantCacheKey, payload, CACHE_TTLS.ASSISTANT, CACHE_MAX_ITEMS.ASSISTANT);
      return res.json(payload);
    }
    const payload = { reply, source: 'gemini', timestamp: new Date().toISOString() };
    setCacheValue(assistantCache, assistantCacheKey, payload, CACHE_TTLS.ASSISTANT, CACHE_MAX_ITEMS.ASSISTANT);
    return res.json(payload);
  } catch (error) {
    console.error('[ASSISTANT ERROR]', error.response?.status || '', error.response?.data || error.message);
    const rawMessage = typeof req.body?.message === 'string' ? req.body.message : '';
    const metrics = req.body?.metrics || {};
    const candidateId = typeof req.body?.candidateId === 'string' ? req.body.candidateId : '';
    const examId = typeof req.body?.examId === 'string' ? req.body.examId : '';
    const activeSignals = Array.isArray(metrics?.signals) ? metrics.signals.slice(0, 6) : [];
    const fallbackReply = buildAssistantFallbackReply(rawMessage, {
      severity: typeof metrics?.severity === 'string' ? metrics.severity : 'OK',
      activeSignals
    });
    const payload = {
      reply: fallbackReply,
      source: 'fallback-error',
      timestamp: new Date().toISOString()
    };
    const assistantCacheKey = JSON.stringify({
      message: normalizeTextForKey(rawMessage),
      candidateId: normalizeTextForKey(candidateId),
      examId: normalizeTextForKey(examId),
      severity: typeof metrics?.severity === 'string' ? metrics.severity : 'OK',
      signals: activeSignals.join(',')
    });
    setCacheValue(assistantCache, assistantCacheKey, payload, CACHE_TTLS.ASSISTANT, CACHE_MAX_ITEMS.ASSISTANT);
    return res.json(payload);
  }
});

// Proxy to Python Monitoring Service
app.post('/analyze-frame', async (req, res) => {
  try {
    const { frame, sessionId } = req.body;
    if (!frame) return res.status(400).json({ error: 'No frame provided' });

    // Forward to Python AI Monitor (Port 8001)
    const response = await axios.post(`${AI_SERVICES.MONITORING}/analyze-live`,
      { frame },
      { timeout: 3000 }
    );

    res.json(response.data);
  } catch (error) {
    console.error('[AI PROXY ERROR]', error.message);
    res.status(502).json({
      error: 'AI Service unreachable',
      details: error.message,
      num_faces: 0,
      confidence: 0,
      anomaly_detected: false
    });
  }
});

// Pre-exam verification: store face/ID/env verification payload (optional, called from frontend before start)
app.post('/exam/verify', (req, res) => {
  const { candidateId, examId, faceVerified, idVerified, envScanPassed, faceSnapshot, idSnapshotUrl } = req.body;
  const verificationId = 'verify_' + Date.now();
  const payload = {
    verificationId,
    candidateId,
    examId,
    faceVerified: !!faceVerified,
    idVerified: !!idVerified,
    envScanPassed: !!envScanPassed,
    faceSnapshot: faceSnapshot || null,
    idSnapshotUrl: idSnapshotUrl || null,
    verifiedAt: new Date().toISOString()
  };
  if (candidateId && examId) {
    pendingVerifications.set(getVerificationKey(candidateId, examId), payload);
  }
  console.log(`[VERIFY] ${candidateId} | face: ${payload.faceVerified} | ID: ${payload.idVerified} | env: ${payload.envScanPassed}`);
  res.json({ success: true, verificationId, ...payload });
});

// Start exam session (optionally with verificationId from pre-exam)
app.post('/exam/start', (req, res) => {
  const { candidateId, examId, verificationId, verification, verificationEvidence } = req.body;
  const sessionId = 'session_' + Date.now();
  const sessionNumber = ++sessionSequence;
  const pendingKey = getVerificationKey(candidateId, examId);
  const pending = pendingVerifications.get(pendingKey) || null;
  const evidence = {
    faceSnapshot: verificationEvidence?.faceSnapshot || pending?.faceSnapshot || null,
    idSnapshotUrl: verificationEvidence?.idSnapshotUrl || pending?.idSnapshotUrl || null,
    verifiedAt: verificationEvidence?.verifiedAt || pending?.verifiedAt || new Date().toISOString()
  };
  if (pending) pendingVerifications.delete(pendingKey);

  activeSessions.set(sessionId, {
    sessionId,
    sessionNumber,
    candidateId,
    examId,
    verificationId: verificationId || null,
    verification: verification || null,
    verificationEvidence: evidence,
    startTime: new Date().toISOString(),
    frameCount: 0,
    warnings: [],
    anomalies: [],
    totalRiskAccum: 0,
    peakRisk: 0,
    violationCount: 0,
    cheatingSignalCounts: {},
    latestSeverity: 'OK',
    latestSignals: [],
    latestRiskScore: 0,
    latestAiInsight: 'Monitoring started',
    lastReason: null,
    lastAnalysisAt: null,
    recordingActive: false,
    recordingStartedAt: null,
    recordingSavedAt: null,
    comfortRequests: [],
    finalAiAnalysis: null,
    lastViolationLoggedAt: 0,
    lastViolationSignature: null
  });

  console.log(`[SESSION] Started: ${sessionId} | student: ${candidateId} | exam: ${examId}`);
  broadcastActiveSessions();
  res.json({
    sessionId,
    sessionNumber,
    candidateId,
    examId,
    startTime: activeSessions.get(sessionId).startTime
  });
});

// End exam session
app.post('/exam/end', (req, res) => {
  const { sessionId, finalAnalysis } = req.body;
  const session = activeSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const endTime = new Date().toISOString();
  session.endTime = endTime;
  session.recordingActive = false;
  if (finalAnalysis && typeof finalAnalysis === 'object') {
    session.finalAiAnalysis = finalAnalysis;
    session.latestAiInsight = finalAnalysis.aiInsight || session.latestAiInsight;
    session.latestSignals = Array.isArray(finalAnalysis.signals) ? finalAnalysis.signals : session.latestSignals;
    session.latestSeverity = finalAnalysis.severity || session.latestSeverity;
    session.latestRiskScore = Number.isFinite(finalAnalysis.riskScore) ? finalAnalysis.riskScore : session.latestRiskScore;
    if (Number.isFinite(finalAnalysis.violationCount)) {
      session.violationCount = Math.max(session.violationCount || 0, finalAnalysis.violationCount);
    }
  }
  console.log(`[SESSION] Ended: ${sessionId} | warnings: ${session.warnings.length}`);
  const summary = buildTeacherSummary(session);

  res.json({
    message: 'Exam session ended',
    sessionId,
    endTime,
    totalWarnings: session.warnings.length,
    summary
  });

  io.to('teachers').emit('session-ended', summary);
  broadcastActiveSessions();
});

// Video upload endpoint
app.post('/exam/upload-video', (req, res) => {
  const { sessionId, videoBase64 } = req.body;
  const session = activeSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const fileName = `${sessionId}_${Date.now()}.webm`;
  const filePath = path.join(uploadsDir, fileName);
  const buffer = Buffer.from(videoBase64, 'base64');

  fs.writeFileSync(filePath, buffer);
  session.videoUrl = `http://localhost:5000/uploads/${fileName}`;
  session.recordingSavedAt = new Date().toISOString();

  console.log(`[VIDEO] Uploaded for session: ${sessionId}`);
  io.to('teachers').emit('student-recording-updated', {
    sessionId,
    sessionNumber: session.sessionNumber || null,
    studentId: session.candidateId,
    studentName: session.candidateId,
      videoUrl: session.videoUrl,
      recordingActive: !!session.recordingActive,
      recordingStartedAt: session.recordingStartedAt || null,
      recordingSavedAt: session.recordingSavedAt || null
    });
  broadcastActiveSessions();
  res.json({ success: true, videoUrl: session.videoUrl });
});

app.get('/exam/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.values())
    .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
    .map((session) => ({
      sessionId: session.sessionId,
      sessionNumber: session.sessionNumber || null,
      candidateId: session.candidateId,
      examId: session.examId,
      verification: {
        faceVerified: !!session.verification?.faceVerified,
        idVerified: !!session.verification?.idVerified,
        envScanPassed: !!session.verification?.envScanPassed
      },
      startTime: session.startTime,
      endTime: session.endTime || null,
      status: session.endTime ? 'Ended' : 'Active',
      warningsRaised: session.warnings.length,
      violationCount: session.violationCount || 0,
      recordingActive: !!session.recordingActive,
      videoUrl: session.videoUrl || null
    }));

  res.json({ sessions });
});

// Get full proctoring report
app.get('/exam/report/:sessionId', (req, res) => {
  const session = activeSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const avgRisk = session.frameCount > 0
    ? safePercent(session.totalRiskAccum / session.frameCount)
    : '0.0';

  res.json({
    sessionId: session.sessionId,
    sessionNumber: session.sessionNumber || null,
    candidateId: session.candidateId,
    examId: session.examId,
    verification: session.verification || null,
    verificationEvidence: session.verificationEvidence || null,
    startTime: session.startTime,
    endTime: session.endTime || null,
    videoUrl: session.videoUrl || null,
    totalFramesAnalyzed: session.frameCount,
    warningsRaised: session.warnings.length,
    flaggedAnomalies: session.anomalies,
    warnings: session.warnings,
    averageRiskPercent: avgRisk,
    peakRiskPercent: safePercent(session.peakRisk || 0),
    cheatingSignalBreakdown: session.cheatingSignalCounts,
    violationCount: session.violationCount || 0,
    comfortRequests: session.comfortRequests || [],
    recordingStartedAt: session.recordingStartedAt || null,
    recordingSavedAt: session.recordingSavedAt || null,
    recordingActive: !!session.recordingActive,
    finalAiAnalysis: session.finalAiAnalysis || null,
    latestAiInsight: session.latestAiInsight || null,
    generatedAt: new Date().toISOString()
  });
});

// ───────────────────────────────────────────
// WEBSOCKET HANDLER
// ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // ── Join exam session ──
  socket.on('join-exam', ({ sessionId, studentName, isTeacher }) => {
    if (isTeacher) {
      teacherSockets.add(socket.id);
      socket.join('teachers');
      console.log(`[TEACHER] Joined monitoring: ${socket.id}`);
      socket.emit('active-sessions', {
        sessions: Array.from(activeSessions.values()).map(buildTeacherSummary)
      });
    } else {
      socketToSession.set(socket.id, sessionId);
      const session = activeSessions.get(sessionId);
      if (session) {
        session.studentSocket = socket.id;
        console.log(`[STUDENT] ${studentName} joined: ${sessionId}`);
        broadcastActiveSessions();
      }
    }
    socket.emit('join-success', {
      sessionId,
      message: isTeacher ? 'Teacher monitoring started' : 'MediaPipe detection active'
    });
  });

  // ── Receive structured MediaPipe analysis result ──
  socket.on('analysis-result', (data) => {
    const {
      sessionId,
      faceCount,
      gazeOff,
      headTurned,
      bodyAnomaly,
      noFace,
      multipleFace,
      riskScore,
      cheatingSignals,
      severity,
      aiInsight,
      violationCount,
      tabSwitchCount,
      timestamp
    } = data;

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.warn('[ANALYSIS] Session not found:', sessionId);
      return;
    }

    session.frameCount++;
    session.totalRiskAccum += riskScore || 0;
    if (riskScore > session.peakRisk) session.peakRisk = riskScore;

    const eventTime = timestamp || new Date().toISOString();
    const normalizedSignals = Array.isArray(cheatingSignals)
      ? Array.from(new Set(cheatingSignals.filter(Boolean)))
      : [];

    // Tally individual signals
    normalizedSignals.forEach(sig => {
      session.cheatingSignalCounts[sig] = (session.cheatingSignalCounts[sig] || 0) + 1;
    });

    // Build human-readable reason from signals or legacy flags
    const reasons = [];
    if (normalizedSignals.length > 0) {
      const msg = {
        NO_FACE: 'Face not visible',
        MULTIPLE_FACE: 'Multiple faces detected',
        PHONE_DETECTED: 'Phone or object detected',
        BOOK_DETECTED: 'Book or reading material detected',
        UNIDENTIFIABLE_OBJECT: 'Unidentifiable object detected',
        EYES_CLOSED: 'Eyes closed 5+ seconds',
        GAZE_OFF: 'Gaze off-screen',
        HEAD_TURNED: 'Head turned',
        BODY_ANOMALY: 'Body posture anomaly',
        BODY_OUT_OF_FRAME: 'Body out of frame',
        EXCESSIVE_MOVEMENT: 'Excessive movement',
        LIP_MOVEMENT_TALKING: 'Lip movement (possible talking)',
        FACE_COVERED: 'Face covered',
        LOOKING_DOWN_PERSISTENT: 'Looking down persistently',
        TAB_SWITCH: 'Tab switch violation',
        AI_TOOL_SUSPECTED: 'AI tool usage suspected',
        CONTENT_PASTED: 'Suspicious content paste'
      };
      const seen = new Set();
      normalizedSignals.forEach(s => { if (msg[s] && !seen.has(s)) { reasons.push(msg[s]); seen.add(s); } });
    }
    if (reasons.length === 0 && (noFace || gazeOff || headTurned || bodyAnomaly)) {
      if (noFace) reasons.push('Student absent from camera');
      if (multipleFace) reasons.push('Multiple faces detected');
      if (gazeOff) reasons.push('Gaze off-screen');
      if (headTurned) reasons.push('Head pose violation');
      if (bodyAnomaly) reasons.push('Body posture anomaly');
    }
    const reason = reasons.length > 0 ? reasons.join('; ') : 'Suspicious behavior';
    const hasViolation = (severity && severity !== 'OK') || normalizedSignals.length > 0 || reasons.length > 0;

    const warning = {
      timestamp: eventTime,
      frame: session.frameCount,
      reason,
      riskScore: riskScore || 0,
      severity: severity || 'WARNING',
      signals: normalizedSignals,
      aiInsight: aiInsight || reason,
      details: { faceCount, gazeOff, headTurned, bodyAnomaly, noFace, multipleFace, tabSwitchCount }
    };

    if (Number.isFinite(violationCount)) {
      session.violationCount = Math.max(session.violationCount || 0, violationCount);
    } else if (hasViolation) {
      session.violationCount = (session.violationCount || 0) + 1;
    }

    session.latestSeverity = severity || 'OK';
    session.latestSignals = normalizedSignals;
    session.latestRiskScore = Number.isFinite(riskScore) ? riskScore : 0;
    session.latestAiInsight = aiInsight || (hasViolation ? reason : 'Secure');
    session.lastReason = hasViolation ? reason : 'No alerts yet';
    session.lastAnalysisAt = eventTime;

    if (!hasViolation) return;

    const violationSignature = `${severity || 'WARNING'}|${normalizedSignals.slice().sort().join('|')}|${reason}`;
    const nowMs = Date.now();
    const persistentSignals = new Set(['TAB_SWITCH', 'AI_TOOL_SUSPECTED', 'CONTENT_PASTED']);
    const onlyPersistentSignals = normalizedSignals.length > 0 && normalizedSignals.every(sig => persistentSignals.has(sig));
    const shouldLogViolation = (
      !session.lastViolationSignature
      || session.lastViolationSignature !== violationSignature
      || (!onlyPersistentSignals && nowMs - (session.lastViolationLoggedAt || 0) >= 3000)
    );
    if (!shouldLogViolation) return;

    session.lastViolationSignature = violationSignature;
    session.lastViolationLoggedAt = nowMs;

    session.warnings.push(warning);
    session.anomalies.push({
      type: normalizedSignals[0] || 'unknown',
      timestamp: warning.timestamp,
      riskScore
    });
    capArray(session.warnings, SESSION_MEMORY_LIMITS.warnings);
    capArray(session.anomalies, SESSION_MEMORY_LIMITS.anomalies);

    console.log(`[ALERT] Student: ${session.candidateId} | Risk: ${(riskScore * 100).toFixed(1)}% | ${severity} | ${reason}`);

    // ── Alert back to student ──
    socket.emit('warning-alert', {
      type: severity,
      message: reason,
      riskScore: (riskScore * 100).toFixed(1) + '%',
      signals: normalizedSignals,
      frameNumber: session.frameCount,
    });

    // ── Alert all teachers ──
    io.to('teachers').emit('student-alert', {
      sessionId,
      sessionNumber: session.sessionNumber || null,
      studentId: session.candidateId,
      studentName: session.candidateId,
      examId: session.examId,
      verification: session.verification || null,
      verificationEvidence: session.verificationEvidence || null,
      startTime: session.startTime,
      timestamp: warning.timestamp,
      reason,
      riskScore,
      signals: normalizedSignals,
      severity,
      aiInsight: aiInsight || reason,
      violationCount: session.violationCount,
      warningsRaised: session.warnings.length,
      tabSwitchCount: Number.isFinite(tabSwitchCount) ? tabSwitchCount : undefined,
      recordingActive: !!session.recordingActive,
      recordingStartedAt: session.recordingStartedAt || null,
      recordingSavedAt: session.recordingSavedAt || null,
      videoUrl: session.videoUrl || null
    });
  });

  // ── Teacher: request current warning list ──
  socket.on('recording-status', (data) => {
    const { sessionId, isRecording, timestamp } = data || {};
    if (!sessionId) return;
    const session = activeSessions.get(sessionId);
    if (!session) return;
    session.recordingActive = !!isRecording;
    if (isRecording && !session.recordingStartedAt) {
      session.recordingStartedAt = timestamp || new Date().toISOString();
    }
    io.to('teachers').emit('student-recording-updated', {
      sessionId,
      sessionNumber: session.sessionNumber || null,
      studentId: session.candidateId,
      studentName: session.candidateId,
      videoUrl: session.videoUrl || null,
      recordingActive: session.recordingActive,
      recordingStartedAt: session.recordingStartedAt || null,
      recordingSavedAt: session.recordingSavedAt || null
    });
    broadcastActiveSessions();
  });

  socket.on('student-comfort-request', (data) => {
    const { sessionId, studentId, studentName, option, count, timestamp } = data || {};
    if (!sessionId) return;
    const session = activeSessions.get(sessionId);
    if (!session) return;
    const request = {
      sessionId,
      sessionNumber: session.sessionNumber || null,
      studentId: studentId || session.candidateId,
      studentName: studentName || session.candidateId,
      option: option || 'UNKNOWN',
      count: Number.isFinite(count) ? count : 1,
      timestamp: timestamp || new Date().toISOString()
    };
    session.comfortRequests.push(request);
    capArray(session.comfortRequests, SESSION_MEMORY_LIMITS.comfortRequests);
    io.to('teachers').emit('student-comfort-request', request);
    broadcastActiveSessions();
  });

  socket.on('get-warnings', () => {
    const sessions = Array.from(activeSessions.values()).map(s => ({
      sessionId: s.sessionId,
      student: s.candidateId,
      warnings: s.warnings.length,
      frames: s.frameCount,
      peakRisk: (s.peakRisk * 100).toFixed(1) + '%'
    }));
    socket.emit('warning-list', { sessions });
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Disconnected: ${socket.id}`);
    socketToSession.delete(socket.id);
    teacherSockets.delete(socket.id);
  });
});

// ───────────────────────────────────────────

const cleanupMemoryState = () => {
  const now = Date.now();

  cleanupRateBucket(ttsRateBuckets, RATE_LIMITS.TTS.windowMs);
  cleanupRateBucket(assistantRateBuckets, RATE_LIMITS.ASSISTANT.windowMs);
  cleanupCache(ttsCache, CACHE_MAX_ITEMS.TTS);
  cleanupCache(assistantCache, CACHE_MAX_ITEMS.ASSISTANT);

  for (const [key, payload] of pendingVerifications.entries()) {
    const ts = Date.parse(payload?.verifiedAt || '');
    if (!Number.isFinite(ts) || now - ts > PENDING_VERIFICATION_RETENTION_MS) {
      pendingVerifications.delete(key);
    }
  }

  for (const [sessionId, session] of activeSessions.entries()) {
    if (!session || typeof session !== 'object') continue;
    capArray(session.warnings, SESSION_MEMORY_LIMITS.warnings);
    capArray(session.anomalies, SESSION_MEMORY_LIMITS.anomalies);
    capArray(session.comfortRequests, SESSION_MEMORY_LIMITS.comfortRequests);
    const endedAt = Date.parse(session.endTime || '');
    if (Number.isFinite(endedAt) && now - endedAt > ENDED_SESSION_RETENTION_MS) {
      activeSessions.delete(sessionId);
    }
  }
};

const cleanupTimer = setInterval(cleanupMemoryState, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n[✓] Backend + WebSocket running on port ${PORT}`);
  console.log(`[✓] Detection Engine: Google MediaPipe (browser-side)`);
  console.log(`[✓] No external AI services required\n`);
  console.log(`REST Endpoints:`);
  console.log(`  POST /exam/start        - Start exam session`);
  console.log(`  POST /exam/end          - End exam session`);
  console.log(`  GET  /exam/report/:id   - Get proctoring report`);
  console.log(`\nWebSocket Events:`);
  console.log(`  join-exam        - Join exam room`);
  console.log(`  analysis-result  - Receive MediaPipe detection results`);
  console.log(`  get-warnings     - Poll current sessions\n`);
});

