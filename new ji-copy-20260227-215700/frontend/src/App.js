import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import './App.css';

let socket = null;

// ─────────────────────────────────────────────────────────────
// CHEATING SIGNAL WEIGHTS
// ─────────────────────────────────────────────────────────────
const WEIGHTS = {
  NO_FACE: 0.92,
  MULTIPLE_FACE: 0.95,
  PHONE_DETECTED: 0.94,
  LAPTOP_DETECTED: 0.82,
  BOOK_DETECTED: 0.75,
  UNIDENTIFIABLE_OBJECT: 0.76,
  EARPHONE_DETECTED: 0.72,
  GAZE_OFF: 0.74,
  HEAD_TURNED: 0.70,
  HEAD_NODDING: 0.48,
  BODY_ANOMALY: 0.58,
  GAZE_OFF_EAR: 0.80,
  HEAD_TURNED_DLIB: 0.75,
  BODY_OUT_OF_FRAME: 0.82,
  EXCESSIVE_MOVEMENT: 0.70,
  LIP_MOVEMENT_TALKING: 0.85,
  FACE_COVERED: 0.80,
  LOOKING_DOWN_PERSISTENT: 0.65,
  TAB_SWITCH: 0.90,           // switched browser tab during exam
  AI_TOOL_SUSPECTED: 0.88,   // AI tool / Copilot shortcut or focus loss detected
  CONTENT_PASTED: 0.78,      // suspicious paste during exam
};

const CHEAT_OBJECTS = {
  'cell phone': 'PHONE_DETECTED',
  'phone': 'PHONE_DETECTED',
  'mobile phone': 'PHONE_DETECTED',
  'smartphone': 'PHONE_DETECTED',
  'laptop': 'LAPTOP_DETECTED',
  'tablet': 'LAPTOP_DETECTED',
  'monitor': 'LAPTOP_DETECTED',
  'book': 'BOOK_DETECTED',
  'headphones': 'EARPHONE_DETECTED',
  'remote': 'PHONE_DETECTED',
  'backpack': 'BOOK_DETECTED',
  'handbag': 'BOOK_DETECTED',
  'briefcase': 'BOOK_DETECTED',
  'suitcase': 'BOOK_DETECTED',
  'mouse': 'PHONE_DETECTED',
};

const UNIDENTIFIABLE_OBJECT_CLASSES = new Set(['book', 'backpack', 'handbag', 'briefcase', 'suitcase']);
const PHONE_CLASSES = new Set(['cell phone', 'phone', 'mobile phone', 'smartphone', 'remote', 'mouse']);

const ALERT_THRESHOLD = 0.42;
const CRIT_THRESHOLD = 0.70;
const GAZE_MARGIN = 0.22;
const HEAD_YAW_DEG = 18;
const SMOOTHING_FRAMES = 3;
const OBJECT_CONF = 0.14;             // non-phone object threshold
const PHONE_OBJECT_CONF = 0.07;       // very sensitive phone threshold
const OBJECT_STICKY_MS = 2200;        // keep object signal for short period to avoid flicker
const VIOLATION_LIMIT = 5;            // auto-recording starts after this many alerts
const EYES_CLOSED_FRAMES = 150;       // ~5 sec at 30fps
const BODY_OUT_FRAME_MARGIN = 0.08;   // key points must be inside this margin
const MOVEMENT_VARIANCE_THRESH = 0.0002; // extreme sensitivity (nose only)
const MAR_VARIANCE_TALKING = 0.0006;  // mouth aspect ratio variance → talking (more sensitive)
const MOVEMENT_HISTORY_LEN = 30;      // ~1 sec at 30fps — for body movement only
const MAR_HISTORY_LEN = 15;           // dedicated shorter window for lip detection
const LIP_TALKING_FRAMES = 5;         // 5 consecutive high-variance frames to flag talking
const LIP_QUIET_GRACE = 3;            // allow up to 3 quiet frames before resetting lip counter
const EXCESSIVE_MOVEMENT_FRAMES = 8; // ~0.25 sec sustained movement
const VOICE_COOLDOWN_MS = 6000;
const WARNING_COOLDOWN_MS = 6000;
const RECORDING_WARNING_INTERVAL_MS = 9000;

const VIOLATION_MESSAGES = {
  TAB_SWITCH: 'Do not switch tabs during the exam.',
  AI_TOOL_SUSPECTED: 'Do not open or use AI tools during the exam.',
  CONTENT_PASTED: 'Do not paste content during the exam.',
  PHONE_DETECTED: 'Remove your phone and keep it out of view.',
  BOOK_DETECTED: 'Remove books or notes from view.',
  UNIDENTIFIABLE_OBJECT: 'Remove unauthorized items from view.',
  LAPTOP_DETECTED: 'Remove secondary devices from view.',
  EARPHONE_DETECTED: 'Remove earphones or headphones.',
  MULTIPLE_FACE: 'Only one person is allowed on camera.',
  NO_FACE: 'Please keep your face visible in the camera.',
  GAZE_OFF: 'Please keep your eyes on the screen.',
  GAZE_LEFT: 'Please keep your eyes on the screen.',
  GAZE_RIGHT: 'Please keep your eyes on the screen.',
  GAZE_OFF_EAR: 'Please keep your eyes on the screen.',
  LOOKING_DOWN_PERSISTENT: 'Please stop looking down and focus on the screen.',
  BODY_OUT_OF_FRAME: 'Stay fully in the camera frame.',
  EXCESSIVE_MOVEMENT: 'Please sit still and avoid excessive movement.',
  FACE_COVERED: 'Do not cover your face.',
  LIP_MOVEMENT_TALKING: 'Please stop talking during the exam.',
  BODY_ANOMALY: 'Please sit upright and face the screen.',
  EYES_CLOSED: 'Please keep your eyes open and focused on the screen.',
  HEAD_TURNED: 'Please face the screen.',
  HEAD_TURNED_DLIB: 'Please face the screen.',
  HEAD_NODDING: 'Please keep your head steady and face the screen.'
};

const normalizeObjectClass = (name = '') => String(name).toLowerCase().trim();
const isPhoneLikeClass = (name = '') => {
  const cls = normalizeObjectClass(name);
  return PHONE_CLASSES.has(cls) || /(phone|mobile|smartphone|cell phone|remote|mouse)/i.test(cls);
};
const formatTimeOnly = (timestamp) => {
  if (!timestamp) return '--';
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? String(timestamp) : parsed.toLocaleTimeString();
};

// Helper for logging errors to backend
const logErrorToBackend = async (error, details = {}) => {
  console.error('[DETECTION ERROR]', error, details);
  try {
    await fetch('http://localhost:5000/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: error.message || String(error),
        details,
        candidateId: localStorage.getItem('candidateId'),
        sessionId: localStorage.getItem('sessionId')
      })
    });
  } catch (e) {
    console.error('Failed to log error to backend:', e);
  }
};

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
function App() {
  const [currentPage, setCurrentPage] = useState('pre-exam');
  const [userRole, setUserRole] = useState('student');
  const [hostReportSessionId, setHostReportSessionId] = useState('');
  const [hostReportSessionNumber, setHostReportSessionNumber] = useState(null);
  const isMeetingUnlocked = (
    localStorage.getItem('digiclass_verified') === 'true'
    && !!localStorage.getItem('sessionId')
    && !!localStorage.getItem('candidateId')
    && !!localStorage.getItem('examId')
  );

  useEffect(() => {
    // ── Global Error Logging ──
    const handleGlobalError = (event) => {
      const { message, filename, lineno, colno, error } = event;
      logErrorToBackend(error || new Error(message), { message, filename, lineno, colno, type: 'GLOBAL_WINDOW_ERROR' });
    };
    const handleRejection = (event) => {
      logErrorToBackend(event.reason || new Error('Unhandled Promise Rejection'), { type: 'UNHANDLED_REJECTION' });
    };
    window.addEventListener('error', handleGlobalError);
    window.addEventListener('unhandledrejection', handleRejection);

    socket = io('http://localhost:5000', {
      reconnection: true, reconnectionDelay: 1000,
      reconnectionDelayMax: 5000, reconnectionAttempts: 5
    });
    return () => {
      window.removeEventListener('error', handleGlobalError);
      window.removeEventListener('unhandledrejection', handleRejection);
      if (socket) socket.disconnect();
    };
  }, []);

  const openHostReport = useCallback((sessionId, sessionNumber = null) => {
    if (!sessionId) return;
    setHostReportSessionId(sessionId);
    setHostReportSessionNumber(sessionNumber);
    setCurrentPage('teacher-reports');
  }, []);

  return (
    <div className="app">
      <nav className="navbar">
        <div className="nav-brand">
          <h1>DIGICLASS</h1>
          <span className="nav-subtitle">AI-Powered Proctored Exam Platform</span>
        </div>
        <div className="nav-links">
          <select value={userRole} onChange={e => setUserRole(e.target.value)} className="role-select">
            <option value="student">Student</option>
            <option value="teacher">Host</option>
          </select>
          {userRole === 'student' ? (
            <>
              <button className={currentPage === 'pre-exam' ? 'active' : ''} onClick={() => setCurrentPage('pre-exam')}>Verify</button>
              <button
                className={`${currentPage === 'exam' ? 'active' : ''} ${!isMeetingUnlocked ? 'disabled' : ''}`}
                onClick={() => {
                  if (isMeetingUnlocked) setCurrentPage('exam');
                  else setCurrentPage('pre-exam');
                }}
                disabled={!isMeetingUnlocked}
                title={!isMeetingUnlocked ? 'Complete full verification to unlock meeting.' : 'Open meeting'}
              >
                Meeting
              </button>
              <button className={currentPage === 'reports' ? 'active' : ''} onClick={() => setCurrentPage('reports')}>History</button>
            </>
          ) : (
            <>
              <button className={currentPage === 'teacher-monitor' ? 'active' : ''} onClick={() => setCurrentPage('teacher-monitor')}>Gallery View</button>
              <button className={currentPage === 'teacher-reports' ? 'active' : ''} onClick={() => setCurrentPage('teacher-reports')}>Reports</button>
              <button className={currentPage === 'dashboard' ? 'active' : ''} onClick={() => setCurrentPage('dashboard')}>System</button>
            </>
          )}
        </div>
      </nav>
      <div className="main-content">
        {userRole === 'student' ? (
          <>
            {currentPage === 'pre-exam' && <PreExam setCurrentPage={setCurrentPage} />}
            {currentPage === 'exam' && (
              isMeetingUnlocked
                ? <LiveExamInterface socket={socket} setCurrentPage={setCurrentPage} />
                : <PreExam setCurrentPage={setCurrentPage} lockedMessage="Complete all verification steps to join the meeting." />
            )}
            {currentPage === 'reports' && <Reports socket={socket} />}
          </>
        ) : (
          <>
            {currentPage === 'teacher-monitor' && <TeacherMonitor socket={socket} onOpenReport={openHostReport} />}
            {currentPage === 'teacher-reports' && (
              <Reports
                socket={socket}
                defaultSessionId={hostReportSessionId}
                defaultSessionNumber={hostReportSessionNumber}
                isProctorHost
              />
            )}
            {currentPage === 'dashboard' && <Dashboard />}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PRE-EXAM — Identity + ID + Environment Verification
// ─────────────────────────────────────────────────────────────
const PREEXAM_PROGRESS_STEPS = ['credentials', 'face', 'id', 'environment', 'ready'];
function PreExam({ setCurrentPage, lockedMessage = null }) {
  const [step, setStep] = useState('welcome');
  const [candidateId, setCandidateId] = useState('');
  const [examId, setExamId] = useState('');
  const [loading, setLoading] = useState(false);
  const [faceVerified, setFaceVerified] = useState(false);
  const [faceSnapshot, setFaceSnapshot] = useState(null);
  const [idVerified, setIdVerified] = useState(false);
  const [idSnapshotUrl, setIdSnapshotUrl] = useState(null);
  const [envScanPassed, setEnvScanPassed] = useState(false);
  const [envScanLog, setEnvScanLog] = useState([]);
  const [mediaStream, setMediaStream] = useState(null);
  const [joinError, setJoinError] = useState(null);
  const [loadingAction, setLoadingAction] = useState(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const faceMeshRef = useRef(null);
  const cocoRef = useRef(null);
  const scanIntervalRef = useRef(null);

  const stepIndex = PREEXAM_PROGRESS_STEPS.indexOf(step);

  const lastFaceResultRef = useRef(null);
  const stableFaceFramesRef = useRef(0);
  const [faceProgress, setFaceProgress] = useState(0); // for live scanning counter UI

  useEffect(() => {
    localStorage.removeItem('digiclass_verified');
  }, []);

  const startCamera = useCallback(async () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setMediaStream(null);
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
      streamRef.current = stream;
      setMediaStream(stream);
      return true;
    } catch (e) {
      console.error('Camera error:', e);
      alert('Camera access required for verification. Please allow camera permission and try again.');
      return false;
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setMediaStream(null);
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
  }, []);

  // Step: Face capture — face present and stable for ~2 sec
  useEffect(() => {
    if (step !== 'face') return;
    let cancelled = false;
    const init = async () => {
      // Retry loop: CDN scripts may still be loading
      for (let attempt = 0; attempt < 5; attempt++) {
        if (window.FaceMesh) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!window.FaceMesh) {
        console.error('FaceMesh not available – proceeding with no face check');
        return;
      }
      if (cancelled) return;
      try {
        const fm = new window.FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${f}` });
        // Lower confidence so it detects faces in varied lighting
        fm.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.4 });
        fm.onResults((r) => {
          if (cancelled || !r) return;
          lastFaceResultRef.current = r;
        });
        await fm.initialize();
        faceMeshRef.current = fm;
        stableFaceFramesRef.current = 0;
        console.log('[✓] PreExam Face Mesh initialized');
      } catch (e) {
        console.error('FaceMesh init error:', e);
        logErrorToBackend(e, { component: 'PreExam.init' });
      }
    };
    init();
    return () => { cancelled = true; };
  }, [step]);

  useEffect(() => {
    if (step !== 'face' || !streamRef.current || faceVerified) return;
    let rafId;
    let frameCount = 0;
    const tick = async () => {
      frameCount++;
      const video = videoRef.current;
      if (!video || video.readyState < 2) { rafId = requestAnimationFrame(tick); return; }

      // If FaceMesh is not yet loaded, still attach stream and wait
      if (!faceMeshRef.current) { rafId = requestAnimationFrame(tick); return; }

      // Only send every 3rd frame to avoid overloading FaceMesh
      if (frameCount % 3 === 0) {
        try { await faceMeshRef.current.send({ image: video }); } catch (e) { console.warn('FaceMesh send error:', e); }
      }

      const r = lastFaceResultRef.current;
      if (r?.multiFaceLandmarks?.length >= 1) {
        stableFaceFramesRef.current++;
        setFaceProgress(Math.min(stableFaceFramesRef.current, 30));
        // Require 30 stable frames (~1 sec) — more lenient than before
        if (stableFaceFramesRef.current >= 30) {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            setFaceSnapshot(canvas.toDataURL('image/jpeg', 0.85));
            setFaceVerified(true);
          } catch (e) { console.error('Snapshot error:', e); }
          return;
        }
      } else {
        stableFaceFramesRef.current = 0;
        setFaceProgress(0);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [step, faceVerified, mediaStream]);

  const handleNextFromCredentials = async () => {
    if (!candidateId.trim() || !examId.trim()) {
      setJoinError('Please enter both Meeting ID and Your Name.');
      return;
    }
    setJoinError(null);
    setLoading(true);
    setLoadingAction('verify');
    try {
      const ok = await startCamera();
      if (ok) {
        setStep('face');
      }
    } catch (err) {
      console.error('Verification start error:', err);
      setJoinError(err.message || 'Could not start camera. Check permission and try again.');
    } finally {
      setLoading(false);
      setLoadingAction(null);
    }
  };

  // Attach stream to video when on face/environment step (ensures camera shows)
  useEffect(() => {
    if ((step === 'face' || step === 'environment') && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => { });
    }
  }, [step, mediaStream]);

  const handleIdUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) { alert('Please upload an image (ID card photo).'); return; }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        alert('Could not read ID image. Please try again.');
        return;
      }
      setIdSnapshotUrl(result);
      setIdVerified(true);
    };
    reader.onerror = () => {
      alert('Could not read ID image. Please try again.');
    };
    reader.readAsDataURL(file);
  };

  const envScanLogRef = useRef([]);
  const handleStartEnvScan = () => {
    setStep('environment');
    setEnvScanLog([]);
    envScanLogRef.current = [];
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    startCamera().then(ok => {
      if (!ok) return;
      const run = async () => {
        if (!cocoRef.current && window.cocoSsd) {
          try { cocoRef.current = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' }); } catch (_) { }
        }
        if (!faceMeshRef.current && window.FaceMesh) {
          const fm = new window.FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${f}` });
          fm.setOptions({ maxNumFaces: 2, refineLandmarks: true, minDetectionConfidence: 0.5 });
          fm.onResults((r) => { if (r) lastFaceResultRef.current = r; });
          await fm.initialize();
          faceMeshRef.current = fm;
        }
        const video = videoRef.current;
        if (!video || video.readyState < 2) return;
        let faceCount = 0;
        if (faceMeshRef.current) {
          try {
            faceMeshRef.current.send({ image: video });
            faceCount = lastFaceResultRef.current?.multiFaceLandmarks?.length ?? 0;
          } catch (_) { }
        }
        let objects = [];
        if (cocoRef.current) {
          try {
            const preds = await cocoRef.current.detect(video);
            objects = preds
              .map(p => ({ ...p, class: normalizeObjectClass(p.class) }))
              .filter(p => p.score >= 0.2 && ['cell phone', 'phone', 'mobile phone', 'smartphone', 'laptop', 'book', 'tv', 'remote', 'backpack', 'handbag', 'briefcase', 'suitcase'].includes(p.class));
          } catch (_) { }
        }
        const hasPhone = objects.some(o => ['cell phone', 'phone', 'mobile phone', 'smartphone', 'remote'].includes(o.class));
        const hasBook = objects.some(o => ['book', 'backpack', 'handbag', 'briefcase', 'suitcase'].includes(o.class));
        const entry = {
          t: new Date().toLocaleTimeString(),
          faceCount,
          hasPhone,
          hasBook,
          ok: faceCount === 1 && !hasPhone && !hasBook
        };
        envScanLogRef.current = [...envScanLogRef.current.slice(-29), entry];
        setEnvScanLog(envScanLogRef.current);
        if (envScanLogRef.current.length >= 20) {
          const recent = envScanLogRef.current.slice(-20);
          const passCount = recent.filter(r => r.ok).length;
          if (passCount >= 14) {
            setEnvScanPassed(true);
            stopCamera();
            setStep('ready');
          }
        }
      };
      scanIntervalRef.current = setInterval(run, 500);
    });
  };

  // Auto-advance to ID step when face is verified
  useEffect(() => {
    if (faceVerified && step === 'face') {
      const t = setTimeout(() => setStep('id'), 1200); // short delay so user sees the ✓
      return () => clearTimeout(t);
    }
  }, [faceVerified, step]);

  const handleStartExam = async () => {
    // Allow start if face is verified (env scan optional — shows warning)
    if (!faceVerified) {
      setJoinError('Please complete face verification first.');
      return;
    }
    if (!idVerified) {
      setJoinError('Please complete ID upload first.');
      return;
    }
    if (!envScanPassed) {
      setJoinError('Please complete environment scan first.');
      return;
    }
    setJoinError(null);
    setLoading(true);
    try {
      await fetch('http://localhost:5000/exam/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId,
          examId,
          faceVerified: true,
          idVerified: true,
          envScanPassed: envScanPassed,
          faceSnapshot: faceSnapshot || undefined,
          idSnapshotUrl: idSnapshotUrl || undefined
        })
      }).catch(() => { }); // fire-and-forget, don't block
      const r = await fetch('http://localhost:5000/exam/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          candidateId,
          examId,
          verification: { faceVerified: true, idVerified: true, envScanPassed },
          verificationEvidence: {
            faceSnapshot: faceSnapshot || null,
            idSnapshotUrl: idSnapshotUrl || null,
            verifiedAt: new Date().toISOString()
          }
        })
      });
      const data = await r.json();
      localStorage.setItem('sessionId', data.sessionId);
      localStorage.setItem('candidateId', candidateId);
      localStorage.setItem('examId', examId);
      localStorage.setItem('digiclass_verified', 'true');
      setCurrentPage('exam');
    } catch (e) {
      setJoinError('Could not start exam: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => () => stopCamera(), [stopCamera]);

  return (
    <div className="join-meeting-container pre-exam-container">
      <div className="join-card pre-exam-card">
        <div className="digiclass-mark">
          <span className="digiclass-badge">DIGICLASS</span>
          <h2>Pre-Exam Verification</h2>
          <p className="pre-exam-intro">Complete all checks to unlock your exam meeting.</p>
        </div>

        {lockedMessage && <p className="join-error">{lockedMessage}</p>}

        {step !== 'welcome' && (
          <div className="pre-exam-steps">
            {PREEXAM_PROGRESS_STEPS.map((stepName, i) => (
              <span key={stepName} className={stepIndex >= i ? 'active' : ''}>{i === PREEXAM_PROGRESS_STEPS.length - 1 ? 'OK' : String(i + 1)}</span>
            ))}
          </div>
        )}

        {step === 'welcome' && (
          <div className="pre-exam-welcome">
            <p className="pre-exam-description">
              Welcome to DIGICLASS secure exam mode. You must complete credential, face, ID, and environment verification before joining the meeting.
            </p>
            <ul className="pre-exam-checklist">
              <li>Enter exam credentials</li>
              <li>Live face verification</li>
              <li>ID document upload</li>
              <li>Room environment scan</li>
            </ul>
            <button className="btn-join" onClick={() => setStep('credentials')}>
              Start Verification
            </button>
          </div>
        )}

        {step === 'credentials' && (
          <>
            <input className="join-input" type="text" placeholder="Exam ID" value={examId} onChange={e => { setExamId(e.target.value); setJoinError(null); }} />
            <input className="join-input" type="text" placeholder="Candidate ID / Name" value={candidateId} onChange={e => { setCandidateId(e.target.value); setJoinError(null); }} />
            {joinError && <p className="join-error">{joinError}</p>}
            <button className="btn-join" onClick={handleNextFromCredentials} disabled={loading}>
              {loading && loadingAction === 'verify' ? 'Starting camera...' : 'Continue to Face Verification'}
            </button>
          </>
        )}

        {step === 'face' && (
          <div className="pre-exam-face-step">
            <p>Position your face in the frame and hold still for auto verification.</p>
            <div className="pre-exam-video-wrap">
              <video
                key={mediaStream ? 'stream-on' : 'stream-off'}
                ref={videoRef}
                srcObject={mediaStream || undefined}
                autoPlay
                muted
                playsInline
                className="pre-exam-video"
              />
              <canvas ref={canvasRef} className="pre-exam-canvas" style={{ display: 'none' }} />
              {!faceVerified && (
                <div className="pre-exam-scan-overlay">
                  Scanning face {faceProgress}/30
                </div>
              )}
            </div>
            {faceVerified ? (
              <p className="verification-ok">Face verified. Moving to ID step...</p>
            ) : (
              <p className="verification-hint">Keep your face centered and visible.</p>
            )}
          </div>
        )}

        {step === 'id' && (
          <div className="pre-exam-id-step">
            <p>Upload your valid student/government ID image.</p>
            <input type="file" accept="image/*" capture="environment" onChange={handleIdUpload} className="pre-exam-file" />
            {idSnapshotUrl && <img src={idSnapshotUrl} alt="ID preview" className="pre-exam-id-preview" />}
            {idVerified && <p className="verification-ok">ID uploaded successfully.</p>}
            <button className="btn-join" onClick={() => setStep('environment')} disabled={!idVerified}>
              Continue to Environment Scan
            </button>
          </div>
        )}

        {step === 'environment' && (
          <div className="pre-exam-env-step">
            <p>Scan your room. Keep only one face visible and remove phones/notes/devices.</p>
            <div className="pre-exam-video-wrap">
              <video
                ref={videoRef}
                srcObject={mediaStream || undefined}
                autoPlay
                muted
                playsInline
                className="pre-exam-video"
              />
            </div>
            <button className="btn-join" onClick={handleStartEnvScan}>Start Environment Scan</button>
            <div className="pre-exam-scan-log">
              {envScanLog.slice(-8).map((log, i) => (
                <div key={i} style={{ color: log.ok ? 'var(--digiclass-success)' : 'var(--digiclass-danger)', fontSize: 12 }}>
                  {log.t} | Faces: {log.faceCount} | Phone: {log.hasPhone ? 'Yes' : 'No'} | Book: {log.hasBook ? 'Yes' : 'No'} | {log.ok ? 'Clear' : 'Violation'}
                </div>
              ))}
            </div>
            {envScanPassed && <p className="verification-ok">Environment scan passed.</p>}
            {!envScanPassed && envScanLog.length > 0 && <p className="verification-hint">Keep scanning until environment passes.</p>}
          </div>
        )}

        {step === 'ready' && (
          <>
            <p>Verification complete. Meeting access is now unlocked.</p>
            <ul className="pre-exam-checklist">
              <li className={faceVerified ? 'ok' : ''}>Face verification complete</li>
              <li className={idVerified ? 'ok' : ''}>ID upload complete</li>
              <li className={envScanPassed ? 'ok' : ''}>Environment scan complete</li>
            </ul>
            {joinError && <p className="join-error">{joinError}</p>}
            <button className="btn-join" onClick={handleStartExam} disabled={loading}>
              {loading ? 'Joining...' : 'Join Meeting'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function estimateHeadPose(landmarks) {
  const nose = landmarks[1], leftEar = landmarks[234], rightEar = landmarks[454];
  // Guard: return neutral if any landmark missing
  if (!nose || !leftEar || !rightEar) return { yawDeg: 0, pitchDeg: 0 };
  const earMidX = (leftEar.x + rightEar.x) / 2, earMidY = (leftEar.y + rightEar.y) / 2;
  return { yawDeg: (nose.x - earMidX) * 180, pitchDeg: (nose.y - earMidY) * 180 };
}

function estimateGaze(landmarks) {
  const leftOuter = landmarks[33], leftInner = landmarks[133], leftTop = landmarks[159], leftBot = landmarks[145];
  const rightOuter = landmarks[263], rightInner = landmarks[362], rightTop = landmarks[386], rightBot = landmarks[374];
  // Iris landmarks only exist when refineLandmarks=true
  const leftPupil = landmarks[468], rightPupil = landmarks[473];
  // Guard: return neutral if essential landmarks missing
  if (!leftOuter || !leftInner || !leftTop || !leftBot || !rightOuter || !rightInner || !rightTop || !rightBot) {
    return { gazeX: 0.5, gazeY: 0.5, eyesClosed: false, earValue: 0.3 };
  }
  let gazeX = 0.5, gazeY = 0.5;
  if (leftPupil && rightPupil) {
    gazeX = ((leftPupil.x - leftOuter.x) / (leftInner.x - leftOuter.x + 0.001) + (rightPupil.x - rightOuter.x) / (rightInner.x - rightOuter.x + 0.001)) / 2;
    gazeY = ((leftPupil.y - leftTop.y) / (leftBot.y - leftTop.y + 0.001) + (rightPupil.y - rightTop.y) / (rightBot.y - rightTop.y + 0.001)) / 2;
  }
  const leftWidth = Math.abs(leftOuter.x - leftInner.x);
  const leftDist = Math.sqrt(Math.pow(leftTop.x - leftBot.x, 2) + Math.pow(leftTop.y - leftBot.y, 2));
  const rightDist = Math.sqrt(Math.pow(rightTop.x - rightBot.x, 2) + Math.pow(rightTop.y - rightBot.y, 2));
  const ear = (leftDist + rightDist) / (2 * leftWidth + 0.001);
  return { gazeX, gazeY, eyesClosed: ear < 0.12, earValue: ear };
}

// Mouth Aspect Ratio (lip movement — talking detection). Face Mesh indices for mouth.
function getMouthAspectRatio(landmarks) {
  const upper = landmarks[13], lower = landmarks[14], left = landmarks[61], right = landmarks[291];
  if (!upper || !lower || !left || !right) return 0;
  const height = Math.sqrt(Math.pow(upper.x - lower.x, 2) + Math.pow(upper.y - lower.y, 2));
  const width = Math.sqrt(Math.pow(left.x - right.x, 2) + Math.pow(left.y - right.y, 2));
  return width > 0.001 ? height / width : 0;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / arr.length;
}

// ─────────────────────────────────────────────────────────────
// LIVE EXAM (ZOOM MEETING)
// ─────────────────────────────────────────────────────────────
function LiveExamInterface({ socket, setCurrentPage }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const faceDetRef = useRef(null);
  const faceMeshRef = useRef(null);
  const poseRef = useRef(null);
  const cocoRef = useRef(null);
  const animFrameRef = useRef(null);
  const mpDoneRef = useRef(false);
  const riskBuffer = useRef([]);
  const latestRef = useRef({ faceCount: 0, faceMeshCount: 0, landmarks: null, poseLandmarks: null, objects: [] });
  const eyesClosedFrames = useRef(0);
  const poseHistoryRef = useRef([]);
  const marHistoryRef = useRef([]);      // dedicated MAR (lip) history — shorter window
  const lipTalkingFramesRef = useRef(0);
  const lipQuietFramesRef = useRef(0);   // grace counter: don't reset on first quiet frame
  const gazeDownFramesRef = useRef(0);
  const excessiveMovementFramesRef = useRef(0);
  // Tab switch & AI tool tracking
  const tabSwitchCountRef = useRef(0);
  const focusLostAtRef = useRef(null);
  const aiToolFlaggedRef = useRef(false);
  const contentPastedRef = useRef(false);
  const tabWarningTimerRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordingVoiceIntervalRef = useRef(null);
  const endRequestedRef = useRef(false);
  const comfortRequestCountsRef = useRef({ washroom: 0, water: 0 });
  const phoneDetectedUntilRef = useRef(0);
  const unidentifiableDetectedUntilRef = useRef(0);

  const [violationCount, setViolationCount] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const violationCountRef = useRef(0);
  const isRecordingRef = useRef(false);
  const startRecordingRef = useRef(() => false);
  const endRecordingTimeoutRef = useRef(null);

  const [isJoined, setIsJoined] = useState(false);
  const [meetingStream, setMeetingStream] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [cameraRetryCount, setCameraRetryCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [videoActive, setVideoActive] = useState(true);
  const [audioActive, setAudioActive] = useState(false);
  const [metrics, setMetrics] = useState({
    faceCount: 0, riskScore: 0, signals: [], severity: 'OK', gazex: 0.5, gazey: 0.5, dir: 'Center',
    aiInsight: 'Monitoring meeting for security...'
  });
  const metricsRef = useRef(metrics);
  const [highAccuracy, setHighAccuracy] = useState(false);
  const serverAnalysisInterval = useRef(null);
  // Tab / focus / AI-tool detection state
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [tabWarning, setTabWarning] = useState(null);    // banner text
  const [aiToolSuspected, setAiToolSuspected] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [calcDisplay, setCalcDisplay] = useState('0');
  const [lastComfortRequest, setLastComfortRequest] = useState(null);
  const [assistantMessages, setAssistantMessages] = useState([
    {
      role: 'assistant',
      text: 'DIGICLASS assistant is ready. Ask for help, technical support, or how to stop the exam safely.',
      timestamp: new Date().toISOString()
    }
  ]);
  const [assistantInput, setAssistantInput] = useState('');
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantVoiceEnabled, setAssistantVoiceEnabled] = useState(true);
  const assistantScrollRef = useRef(null);
  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);
  const lastVoiceAtRef = useRef(0);
  const lastVoiceTextRef = useRef('');
  const lastWarningAtRef = useRef(0);
  const lastWarningTextRef = useRef('');
  const announcedViolationKeysRef = useRef(new Set());

  const sessionId = localStorage.getItem('sessionId');
  const candidateId = localStorage.getItem('candidateId');

  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    if (window?.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const showBanner = useCallback((text, durationMs = 6000) => {
    if (!text) return;
    if (tabWarningTimerRef.current) clearTimeout(tabWarningTimerRef.current);
    setTabWarning(text);
    if (durationMs > 0) {
      tabWarningTimerRef.current = setTimeout(() => setTabWarning(null), durationMs);
    }
  }, []);

  const speakWithBrowserTts = useCallback((text) => {
    if (!text || !window?.speechSynthesis || !window?.SpeechSynthesisUtterance) return false;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice = voices.find(v => /^en(-|_)(IN|US|GB)$/i.test(v.lang))
        || voices.find(v => /^en/i.test(v.lang));
      if (preferredVoice) utterance.voice = preferredVoice;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (error) {
      console.warn('Browser TTS fallback failed:', error);
      return false;
    }
  }, []);

  const playSpokenText = useCallback(async (text) => {
    if (!text) return false;
    try {
      const res = await fetch('http://localhost:5000/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!res.ok) {
        return speakWithBrowserTts(text);
      }
      const blob = await res.blob();
      if (!blob || !blob.size) {
        return speakWithBrowserTts(text);
      }
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      const audio = new Audio(url);
      audio.volume = 1;
      audioRef.current = audio;
      audioUrlRef.current = url;
      audio.onended = () => {
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        }
      };
      const playPromise = audio.play();
      if (playPromise?.then) {
        try {
          await playPromise;
          return true;
        } catch (_) {
          return speakWithBrowserTts(text);
        }
      }
      return true;
    } catch (e) {
      console.warn('TTS failed:', e);
      return speakWithBrowserTts(text);
    }
  }, [speakWithBrowserTts]);

  const speakViolation = useCallback(async (text) => {
    if (!text) return;
    const now = Date.now();
    if (text === lastVoiceTextRef.current && now - lastVoiceAtRef.current < VOICE_COOLDOWN_MS) return;
    if (now - lastVoiceAtRef.current < 1500) return;
    lastVoiceAtRef.current = now;
    lastVoiceTextRef.current = text;
    await playSpokenText(text);
  }, [playSpokenText]);

  const notifyViolation = useCallback((text, durationMs = 6000, options = {}) => {
    const {
      key = text,
      speak = true,
      speakOnce = false
    } = options;
    if (!text) return;
    const now = Date.now();
    if (text === lastWarningTextRef.current && now - lastWarningAtRef.current < WARNING_COOLDOWN_MS) return;
    lastWarningAtRef.current = now;
    lastWarningTextRef.current = text;
    showBanner(text, durationMs);
    if (!speak) return;
    if (speakOnce) {
      if (announcedViolationKeysRef.current.has(key)) return;
      announcedViolationKeysRef.current.add(key);
    }
    speakViolation(text);
  }, [showBanner, speakViolation]);

  useEffect(() => {
    if (recordingVoiceIntervalRef.current) {
      clearInterval(recordingVoiceIntervalRef.current);
      recordingVoiceIntervalRef.current = null;
    }
    if (!isJoined || !isRecording) return;

    const pushContinuousRecordingWarning = () => {
      const latestMetrics = metricsRef.current || {};
      const hasSignals = Array.isArray(latestMetrics.signals) && latestMetrics.signals.length > 0;
      const hasActiveRisk = (latestMetrics.severity && latestMetrics.severity !== 'OK') || hasSignals;
      const riskMessage = hasActiveRisk
        ? (latestMetrics.aiInsight || 'Suspicious behavior detected.')
        : 'Auto recording is active due to earlier violations.';
      speakViolation(`Warning. ${riskMessage} Please follow exam rules.`);
    };

    // Speak immediately when recording starts, then continue periodically.
    pushContinuousRecordingWarning();
    recordingVoiceIntervalRef.current = setInterval(pushContinuousRecordingWarning, RECORDING_WARNING_INTERVAL_MS);

    return () => {
      if (recordingVoiceIntervalRef.current) {
        clearInterval(recordingVoiceIntervalRef.current);
        recordingVoiceIntervalRef.current = null;
      }
    };
  }, [isJoined, isRecording, speakViolation]);

  // ── Tab Switch & AI Tool Detection ──────────────────────────────────────────
  useEffect(() => {
    if (!isJoined) return;

    // 1. TAB SWITCH — visibilitychange fires when user switches to another tab
    const onVisibilityChange = () => {
      if (document.hidden) {
        // User left the tab
        tabSwitchCountRef.current++;
        setTabSwitchCount(tabSwitchCountRef.current);
        // Clear any previous auto-dismiss timer
        const msg = `Tab switch #${tabSwitchCountRef.current}. ${VIOLATION_MESSAGES.TAB_SWITCH}`;
        notifyViolation(msg, 0, { key: 'TAB_SWITCH', speakOnce: true });
        fetch('http://localhost:5000/log-error', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'TAB_SWITCH', details: { count: tabSwitchCountRef.current }, candidateId: localStorage.getItem('candidateId'), sessionId: localStorage.getItem('sessionId') })
        }).catch(() => { });
      }
      // Note: do NOT auto-dismiss here — let the user dismiss it manually via the Dismiss button
    };

    // 2. WINDOW BLUR — ONLY track if the tab is still visible (= external app opened, not a tab switch)
    //    When switching tabs: BOTH visibilitychange AND blur fire — we ignore blur in that case
    const onBlur = () => {
      if (!document.hidden) {
        // Tab is still visible but window lost focus → user opened another app (Copilot, etc.)
        focusLostAtRef.current = Date.now();
      }
    };

    // 3. WINDOW FOCUS — returned to exam window from external app
    const onFocus = () => {
      if (focusLostAtRef.current && !document.hidden) {
        const lostMs = Date.now() - focusLostAtRef.current;
        focusLostAtRef.current = null;
        if (lostMs > 2500) {
          // Lost focus to external app for >2.5 sec — flag AI tool
          aiToolFlaggedRef.current = true;
          setAiToolSuspected(true);
          notifyViolation(VIOLATION_MESSAGES.AI_TOOL_SUSPECTED, 8000, { key: 'AI_TOOL_SUSPECTED', speakOnce: true });
          fetch('http://localhost:5000/log-error', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'AI_TOOL_SUSPECTED', details: { focusLostMs: lostMs }, candidateId: localStorage.getItem('candidateId'), sessionId: localStorage.getItem('sessionId') })
          }).catch(() => { });
        } else {
          focusLostAtRef.current = null; // short blur — ignore
        }
      }
    };

    // 4. KEYBOARD SHORTCUTS — detect AI tool shortcuts
    //    Copilot (Edge): Ctrl+Shift+. or Ctrl+Shift+B
    //    ChatGPT desktop: Ctrl+Shift+G
    //    Windows Copilot sidebar: Win key can't be caught, but Ctrl+Shift combos can
    const AI_SHORTCUTS = new Set([
      'Ctrl+Shift+.',   // Edge Copilot
      'Ctrl+Shift+b',   // Edge Copilot
      'Ctrl+Shift+g',   // ChatGPT
      'Ctrl+Shift+h',   // Copilot / History
      'Ctrl+Shift+a',   // Common AI assistant
      'Ctrl+Shift+p',   // AI features in various browsers
    ]);
    const onKeyDown = (e) => {
      const combo = `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}`;
      if (AI_SHORTCUTS.has(combo)) {
        e.preventDefault(); // block the shortcut
        aiToolFlaggedRef.current = true;
        setAiToolSuspected(true);
        notifyViolation(VIOLATION_MESSAGES.AI_TOOL_SUSPECTED, 6000, { key: 'AI_TOOL_SUSPECTED', speakOnce: true });
        fetch('http://localhost:5000/log-error', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'AI_TOOL_SUSPECTED', details: { shortcut: combo }, candidateId: localStorage.getItem('candidateId'), sessionId: localStorage.getItem('sessionId') })
        }).catch(() => { });
      }
    };

    // 5. PASTE DETECTION — flag any paste during exam
    const onPaste = (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (text.length > 20) { // ignore small pastes like password manager
        contentPastedRef.current = true;
        notifyViolation(VIOLATION_MESSAGES.CONTENT_PASTED, 6000, { key: 'CONTENT_PASTED', speakOnce: true });
        fetch('http://localhost:5000/log-error', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'CONTENT_PASTED', details: { length: text.length, preview: text.substring(0, 80) }, candidateId: localStorage.getItem('candidateId'), sessionId: localStorage.getItem('sessionId') })
        }).catch(() => { });
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('paste', onPaste);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('paste', onPaste);
      if (tabWarningTimerRef.current) clearTimeout(tabWarningTimerRef.current);
    };
  }, [isJoined, notifyViolation]);
  // ────────────────────────────────────────────────────────────────────────────

  const setVideoRef = useCallback((el) => {
    videoRef.current = el;
  }, []);

  useEffect(() => {
    if (!videoRef.current || !meetingStream) return;
    videoRef.current.srcObject = meetingStream;
    videoRef.current.play().catch(() => { });
  }, [meetingStream]);

  const computeRisk = useCallback((signals) => {
    if (!signals.length) return 0;
    const sorted = signals.map(s => WEIGHTS[s] || 0).sort((a, b) => b - a);
    let score = sorted[0];
    for (let i = 1; i < sorted.length; i++) score += sorted[i] * 0.15;
    return Math.min(score, 1.0);
  }, []);

  const onFaceDetResults = useCallback(r => {
    if (!r) return;
    latestRef.current.faceCount = r.detections ? r.detections.length : 0;
  }, []);
  const onFaceMeshResults = useCallback(r => {
    if (!r) return;
    latestRef.current.landmarks = r.multiFaceLandmarks?.[0] || null;
    latestRef.current.faceMeshCount = r.multiFaceLandmarks ? r.multiFaceLandmarks.length : 0;
  }, []);
  const onPoseResults = useCallback(r => {
    if (!r) return;
    latestRef.current.poseLandmarks = r.poseLandmarks || null;
  }, []);

  const initModels = useCallback(async () => {
    if (mpDoneRef.current) return;
    mpDoneRef.current = true;
    try {
      if (window.FaceDetection) {
        const fd = new window.FaceDetection({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4.1633559619/${f}` });
        fd.setOptions({ model: 'short', minDetectionConfidence: 0.3 }); // lower → catches faces better
        fd.onResults(onFaceDetResults); faceDetRef.current = fd;
        console.log('[✓] MediaPipe Face Detection loaded');
      } else {
        console.warn('FaceDetection not available, using FaceMesh as fallback');
      }

      if (window.FaceMesh) {
        const fm = new window.FaceMesh({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${f}` });
        // refineLandmarks MUST be true — estimateGaze uses iris landmarks 468/473 which only exist with refined landmarks
        fm.setOptions({ maxNumFaces: 2, refineLandmarks: true, minDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
        fm.onResults(onFaceMeshResults);
        await fm.initialize();
        faceMeshRef.current = fm;
        console.log('[✓] MediaPipe Face Mesh initialized');
      } else {
        throw new Error('window.FaceMesh not found - script failed to load');
      }

      if (window.Pose) {
        const pose = new window.Pose({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.4.1633559619/${f}` });
        pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
        pose.onResults(onPoseResults);
        await pose.initialize();
        poseRef.current = pose;
        console.log('[✓] MediaPipe Pose initialized');
      } else {
        throw new Error('window.Pose not found - script failed to load');
      }

      if (window.cocoSsd) {
        cocoRef.current = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
        console.log('[✓] COCO-SSD loaded');
      } else {
        console.warn('COCO-SSD not available – object detection disabled');
      }
    } catch (err) {
      console.error('[INIT ERROR]', err);
      logErrorToBackend(err, { component: 'initModels' });
      // Don't block exam start for model init errors — just log and continue
      console.warn('Some AI models failed to load, continuing with available ones.');
    }
  }, [onFaceDetResults, onFaceMeshResults, onPoseResults]);

  const analyzeFrame = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    if (video.readyState < 2) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // ctx.drawImage(video, 0, 0, canvas.width, canvas.height); // Zoom theme handles video backdrop

    try {
      if (faceDetRef.current) await faceDetRef.current.send({ image: video });
      if (faceMeshRef.current) await faceMeshRef.current.send({ image: video });
      if (poseRef.current) await poseRef.current.send({ image: video });
    } catch { }

    // COCO-SSD removed from main loop — now throttled in useEffect
    const objects = latestRef.current.objects || [];

    const { faceCount, faceMeshCount, landmarks, poseLandmarks } = latestRef.current;

    // REDUNDANCY: Use maximum of FaceDetection count and FaceMesh count
    const effectiveFaceCount = Math.max(faceCount, faceMeshCount || 0);

    const signals = [];
    if (effectiveFaceCount === 0) signals.push('NO_FACE');
    if (effectiveFaceCount >= 2) signals.push('MULTIPLE_FACE');
    const nowMs = Date.now();
    const hasImmediatePhone = objects.some(o => isPhoneLikeClass(o.class));
    const hasImmediateUnidentifiable = objects.some(o => UNIDENTIFIABLE_OBJECT_CLASSES.has(o.class));
    if (hasImmediatePhone) phoneDetectedUntilRef.current = nowMs + OBJECT_STICKY_MS;
    if (hasImmediateUnidentifiable) unidentifiableDetectedUntilRef.current = nowMs + OBJECT_STICKY_MS;
    objects.forEach(o => {
      const s = isPhoneLikeClass(o.class) ? 'PHONE_DETECTED' : CHEAT_OBJECTS[o.class];
      if (s && !signals.includes(s)) signals.push(s);
    });
    if (phoneDetectedUntilRef.current > nowMs && !signals.includes('PHONE_DETECTED')) {
      signals.push('PHONE_DETECTED');
    }
    if (objects.some(o => UNIDENTIFIABLE_OBJECT_CLASSES.has(o.class)) && !signals.includes('UNIDENTIFIABLE_OBJECT')) {
      signals.push('UNIDENTIFIABLE_OBJECT');
    }
    if (unidentifiableDetectedUntilRef.current > nowMs && !signals.includes('UNIDENTIFIABLE_OBJECT')) {
      signals.push('UNIDENTIFIABLE_OBJECT');
    }

    let gx = 0.5, gy = 0.5, dir = 'Center';
    if (landmarks) {
      const { yawDeg } = estimateHeadPose(landmarks);
      if (Math.abs(yawDeg) > HEAD_YAW_DEG) signals.push('HEAD_TURNED');
      const { gazeX, gazeY, eyesClosed, earValue } = estimateGaze(landmarks);
      gx = gazeX; gy = gazeY;
      // GAZE LEFT/RIGHT only — no up/down gaze detection (per user request)
      if (gx < GAZE_MARGIN) { signals.push('GAZE_LEFT'); dir = 'Left'; }
      else if (gx > 1 - GAZE_MARGIN) { signals.push('GAZE_RIGHT'); dir = 'Right'; }
      // GAZE_OFF only triggered by left/right — not by vertical gaze
      if (signals.some(s => s === 'GAZE_LEFT' || s === 'GAZE_RIGHT')) signals.push('GAZE_OFF');

      // LOOKING_DOWN_PERSISTENT: head pitch check via landmark — sustained 3 sec
      if (gy > 0.70) { gazeDownFramesRef.current++; if (gazeDownFramesRef.current > 90) signals.push('LOOKING_DOWN_PERSISTENT'); } else gazeDownFramesRef.current = 0;

      const mar = getMouthAspectRatio(landmarks);
      // Use dedicated shorter MAR window (MAR_HISTORY_LEN=15) for faster lip response
      marHistoryRef.current = [...marHistoryRef.current.slice(-(MAR_HISTORY_LEN - 1)), mar];
      if (marHistoryRef.current.length >= MAR_HISTORY_LEN) {
        const varMar = variance(marHistoryRef.current);
        if (varMar > MAR_VARIANCE_TALKING) {
          lipTalkingFramesRef.current++;
          lipQuietFramesRef.current = 0; // reset quiet grace counter
          if (lipTalkingFramesRef.current >= LIP_TALKING_FRAMES) signals.push('LIP_MOVEMENT_TALKING');
        } else {
          // Grace period: don't reset talking counter on first few quiet frames
          lipQuietFramesRef.current++;
          if (lipQuietFramesRef.current >= LIP_QUIET_GRACE) {
            lipTalkingFramesRef.current = 0;
            lipQuietFramesRef.current = 0;
          }
        }
      }
    }

    // ── Body out of frame & excessive movement ──
    if (poseLandmarks) {
      const nose = poseLandmarks[0], lSh = poseLandmarks[11], rSh = poseLandmarks[12], lWr = poseLandmarks[15], rWr = poseLandmarks[16];
      const margin = BODY_OUT_FRAME_MARGIN;
      const oob = (p) => !p || (p.visibility !== undefined && p.visibility < 0.5) || p.x < margin || p.x > 1 - margin || p.y < margin || p.y > 1 - margin;
      if (oob(nose) || oob(lSh) || oob(rSh)) signals.push('BODY_OUT_OF_FRAME');

      if (nose) {
        // Isolate MOVEMENT tracking to the NOSE only to eliminate body-scale bias (noise)
        poseHistoryRef.current = [...poseHistoryRef.current.slice(-(MOVEMENT_HISTORY_LEN * 2 - 2)), nose.x, nose.y];
        if (poseHistoryRef.current.length >= MOVEMENT_HISTORY_LEN * 2) {
          const xVals = poseHistoryRef.current.filter((_, i) => i % 2 === 0);
          const yVals = poseHistoryRef.current.filter((_, i) => i % 2 === 1);
          const v = variance(xVals) + variance(yVals);
          // Diagnostic log for tuning
          if (frameCount % 60 === 0) console.log(`[AI] Movement variance: ${v.toFixed(6)} (Threshold: ${MOVEMENT_VARIANCE_THRESH})`);

          if (v > MOVEMENT_VARIANCE_THRESH) {
            excessiveMovementFramesRef.current++;
            if (excessiveMovementFramesRef.current >= EXCESSIVE_MOVEMENT_FRAMES) {
              if (!signals.includes('EXCESSIVE_MOVEMENT')) {
                console.log('[AI] EXCESSIVE MOVEMENT triggered');
                signals.push('EXCESSIVE_MOVEMENT');
              }
            }
          } else {
            excessiveMovementFramesRef.current = 0;
          }
        }
      }
      if (nose && lSh && rSh) {
        const shoulderMidX = (lSh.x + rSh.x) / 2;
        if (Math.abs(nose.x - shoulderMidX) > 0.15) signals.push('BODY_ANOMALY');
        if (lWr && rWr) {
          const dL = Math.sqrt(Math.pow(lWr.x - nose.x, 2) + Math.pow(lWr.y - nose.y, 2));
          const dR = Math.sqrt(Math.pow(rWr.x - nose.x, 2) + Math.pow(rWr.y - nose.y, 2));
          if (dL < 0.18 || dR < 0.18) { signals.push('FACE_COVERED'); signals.push('BODY_ANOMALY'); }
        }
      }
    }

    // ── Inject tab-switch / AI-tool signals into per-frame analysis ──
    if (tabSwitchCountRef.current > 0) signals.push('TAB_SWITCH');
    if (aiToolFlaggedRef.current) signals.push('AI_TOOL_SUSPECTED');
    if (contentPastedRef.current) signals.push('CONTENT_PASTED');

    const rawRisk = computeRisk(signals);
    riskBuffer.current.push(rawRisk);
    if (riskBuffer.current.length > SMOOTHING_FRAMES) riskBuffer.current.shift();
    const risk = riskBuffer.current.reduce((a, b) => a + b, 0) / riskBuffer.current.length;
    const severity = risk >= CRIT_THRESHOLD ? 'CRITICAL' : risk >= ALERT_THRESHOLD ? 'WARNING' : 'OK';

    if (severity !== 'OK') {
      // Throttled violation count to avoid frame-by-frame spam
      if (!latestRef.current.lastViolationTime || Date.now() - latestRef.current.lastViolationTime > 3000) {
        latestRef.current.lastViolationTime = Date.now();
        violationCountRef.current++;
        setViolationCount(violationCountRef.current);
        if (violationCountRef.current >= VIOLATION_LIMIT) startRecordingRef.current();
      }
    }

    // Generate AI Insight
    const prioritySignals = [
      'TAB_SWITCH',
      'AI_TOOL_SUSPECTED',
      'CONTENT_PASTED',
      'PHONE_DETECTED',
      'LAPTOP_DETECTED',
      'EARPHONE_DETECTED',
      'BOOK_DETECTED',
      'LIP_MOVEMENT_TALKING',
      'EYES_CLOSED',
      'BODY_OUT_OF_FRAME',
      'EXCESSIVE_MOVEMENT',
      'FACE_COVERED',
      'GAZE_OFF',
      'GAZE_LEFT',
      'GAZE_RIGHT',
      'GAZE_OFF_EAR',
      'LOOKING_DOWN_PERSISTENT',
      'BODY_ANOMALY',
      'HEAD_TURNED',
      'HEAD_TURNED_DLIB',
      'HEAD_NODDING',
      'MULTIPLE_FACE',
      'NO_FACE'
    ];
    let primarySignal = prioritySignals.find(signal => signals.includes(signal));
    if (!primarySignal && signals.length) primarySignal = signals[0];
    const keepHigherPriorityInsight = ['TAB_SWITCH', 'AI_TOOL_SUSPECTED', 'CONTENT_PASTED', 'PHONE_DETECTED']
      .some(signal => signals.includes(signal));
    if (signals.includes('UNIDENTIFIABLE_OBJECT') && !keepHigherPriorityInsight) {
      primarySignal = 'UNIDENTIFIABLE_OBJECT';
    }
    let insight = 'Secure';
    if (primarySignal) {
      if (primarySignal === 'TAB_SWITCH') {
        insight = `Tab switched ${tabSwitchCountRef.current} time(s) during exam. ${VIOLATION_MESSAGES.TAB_SWITCH}`;
      } else {
        insight = VIOLATION_MESSAGES[primarySignal] || 'Violation detected.';
      }
    }

    setMetrics(prev => ({ ...prev, faceCount: effectiveFaceCount, riskScore: risk, signals, severity, gazex: gx, gazey: gy, dir, aiInsight: insight }));

    if (severity !== 'OK' && primarySignal) {
      const singleEventSignals = new Set(['TAB_SWITCH', 'AI_TOOL_SUSPECTED', 'CONTENT_PASTED']);
      if (!singleEventSignals.has(primarySignal)) {
        const duration = primarySignal === 'TAB_SWITCH' ? 0 : 6000;
        notifyViolation(insight, duration);
      }
    }

    if (socket) {
      socket.emit('analysis-result', {
        sessionId,
        faceCount: effectiveFaceCount,
        riskScore: risk,
        cheatingSignals: signals,
        severity,
        aiInsight: insight,
        violationCount: violationCountRef.current,
        tabSwitchCount: tabSwitchCountRef.current,
        timestamp: new Date().toISOString()
      });
    }

    // Server-side High Accuracy Fallback
    if (highAccuracy || (effectiveFaceCount === 0 && signals.length === 1)) {
      if (!serverAnalysisInterval.current || Date.now() - serverAnalysisInterval.current > 2000) {
        serverAnalysisInterval.current = Date.now();
        const frame = canvas.toDataURL('image/jpeg', 0.6);
        fetch('http://localhost:5000/analyze-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ frame, sessionId })
        }).then(r => r.json()).then(data => {
          const finalFaceCount = Math.max(data.num_faces || 0, effectiveFaceCount);

          setMetrics(prev => ({
            ...prev,
            faceCount: finalFaceCount,
            severity: data.anomaly_detected ? 'CRITICAL' : prev.severity,
            aiInsight: data.anomaly_detected ? `🔍 Server AI: ${data.num_faces} faces/anomaly detected` : prev.aiInsight
          }));

          if (data.anomaly_detected || data.num_faces > 1) {
            violationCountRef.current++;
            setViolationCount(violationCountRef.current);
            if (violationCountRef.current >= VIOLATION_LIMIT) startRecordingRef.current();
          }
        }).catch(e => console.error('Server AI Error:', e));
      }
    }

    // Draw professional landmarks
    if (landmarks) {
      ctx.save(); ctx.globalAlpha = 0.4;
      if (window.drawConnectors) window.drawConnectors(ctx, landmarks, window.FACEMESH_TESSELATION, { color: '#2d8cff', lineWidth: 0.5 });
      ctx.restore();
    }
    if (poseLandmarks && window.drawConnectors && window.POSE_CONNECTIONS) {
      ctx.save(); ctx.globalAlpha = 0.5;
      window.drawConnectors(ctx, poseLandmarks, window.POSE_CONNECTIONS, { color: '#00ff00', lineWidth: 1.5 });
      ctx.restore();
    }
    objects.forEach(o => {
      const [x, y, w, h] = o.bbox;
      const isCheat = CHEAT_OBJECTS[o.class];
      if (isCheat) {
        console.log(`[AI] Cheat object detected: ${o.class} (${(o.score * 100).toFixed(0)}%)`);
        ctx.strokeStyle = '#ff0000'; // RED for violations
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = '#2d8cff';
        ctx.lineWidth = 2;
      }
      ctx.strokeRect(x, y, w, h);
    });
  }, [socket, sessionId, computeRisk, notifyViolation]);

  useEffect(() => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('Camera not supported. Use HTTPS or a modern browser.');
      return;
    }
    let objTimer;
    const start = async () => {
      try {
        setCameraError(null);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user'
          },
          audio: true
        });
        streamRef.current = stream;
        setMeetingStream(stream);
        await initModels();
        setIsJoined(true);
        if (socket) socket.emit('join-exam', { sessionId, studentName: candidateId, isTeacher: false });

        objTimer = setInterval(async () => {
          if (cocoRef.current && videoRef.current && videoRef.current.readyState >= 2) {
            try {
              const preds = await cocoRef.current.detect(videoRef.current);
              latestRef.current.objects = preds
                .map(p => ({ ...p, class: normalizeObjectClass(p.class) }))
                .filter(p => {
                  const isPhoneLike = isPhoneLikeClass(p.class);
                  const mappedSignal = isPhoneLike ? 'PHONE_DETECTED' : CHEAT_OBJECTS[p.class];
                  if (!mappedSignal) return false;
                  const threshold = isPhoneLike ? PHONE_OBJECT_CONF : OBJECT_CONF;
                  return p.score >= threshold;
                });
            } catch (err) { console.error('Object detect error:', err); }
          }
        }, 150);

        const loop = async () => {
          if (videoActive) await analyzeFrame();
          animFrameRef.current = requestAnimationFrame(loop);
        };
        animFrameRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.error('Meeting camera error:', err);
        const isDeviceInUse = err.name === 'NotReadableError' || (err.message && /in use|in use by another|already in use|busy/i.test(err.message));
        const message = isDeviceInUse
          ? 'Camera is in use by another app or tab. Close other apps (Zoom, Teams, other browser tabs) using the camera, then click Retry.'
          : 'Camera error: ' + (err.message || 'Please allow camera and refresh.');
        setCameraError(message);
      }
    };
    start();
    return () => {
      if (endRecordingTimeoutRef.current) {
        clearTimeout(endRecordingTimeoutRef.current);
        endRecordingTimeoutRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch (_) { }
      }
      if (objTimer) clearInterval(objTimer);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      setMeetingStream(null);
    };
  }, [cameraRetryCount]);

  const handleRetryCamera = () => {
    setCameraError(null);
    setCameraRetryCount(c => c + 1);
  };

  const requestComfortOption = useCallback((optionType) => {
    const option = optionType === 'washroom' ? 'washroom' : 'water';
    comfortRequestCountsRef.current[option] = (comfortRequestCountsRef.current[option] || 0) + 1;
    const label = option === 'washroom' ? 'Washroom break requested' : 'Water break requested';
    setLastComfortRequest(label);
    showBanner(`${label}. Please stay visible in camera.`, 3500);

    if (socket) {
      socket.emit('student-comfort-request', {
        sessionId,
        studentId: candidateId,
        studentName: candidateId,
        option: option.toUpperCase(),
        count: comfortRequestCountsRef.current[option],
        timestamp: new Date().toISOString()
      });
    }
  }, [candidateId, sessionId, socket, showBanner]);

  const appendCalcValue = useCallback((value) => {
    setCalcDisplay(prev => {
      const current = prev === 'Error' ? '0' : prev;
      if (current === '0' && value !== '.' && !'+-*/%'.includes(value)) return value;
      if ('+-*/%'.includes(value) && '+-*/%'.includes(current.slice(-1))) return `${current.slice(0, -1)}${value}`;
      return `${current}${value}`;
    });
  }, []);

  const clearCalculator = useCallback(() => setCalcDisplay('0'), []);
  const backspaceCalculator = useCallback(() => {
    setCalcDisplay(prev => {
      if (prev === 'Error') return '0';
      if (prev.length <= 1) return '0';
      return prev.slice(0, -1);
    });
  }, []);

  const evaluateCalculator = useCallback(() => {
    if (!/^[0-9+\-*/%.() ]+$/.test(calcDisplay)) {
      setCalcDisplay('Error');
      return;
    }
    try {
      const result = Function(`"use strict"; return (${calcDisplay})`)();
      if (!Number.isFinite(result)) {
        setCalcDisplay('Error');
        return;
      }
      setCalcDisplay(String(Number(result.toFixed(8))));
    } catch {
      setCalcDisplay('Error');
    }
  }, [calcDisplay]);

  const finalizeMeeting = useCallback(async () => {
    if (latestRef.current.finalized) return;
    latestRef.current.finalized = true;
    const latestMetrics = metricsRef.current || {};
    try {
      await fetch('http://localhost:5000/exam/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          finalAnalysis: {
            aiInsight: latestMetrics.aiInsight,
            riskScore: latestMetrics.riskScore,
            severity: latestMetrics.severity,
            signals: latestMetrics.signals,
            violationCount: violationCountRef.current,
            tabSwitchCount: tabSwitchCountRef.current,
            aiToolSuspected: aiToolFlaggedRef.current,
            contentPasted: contentPastedRef.current,
            comfortRequests: comfortRequestCountsRef.current
          }
        })
      });
    } catch (error) {
      console.error('End meeting request failed:', error);
    }
    localStorage.removeItem('digiclass_verified');
    setCurrentPage('reports');
  }, [sessionId, setCurrentPage]);

  const startRecording = useCallback((options = {}) => {
    const {
      force = false,
      silent = false,
      reason = 'violations'
    } = options;
    if (isRecordingRef.current || !streamRef.current) return false;
    if (!force && violationCountRef.current < VIOLATION_LIMIT) return false;
    console.log(`[VIDEO] Recording START requested (${reason})`);
    const getMimeType = () => {
      const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'];
      for (const t of types) { if (MediaRecorder.isTypeSupported(t)) return t; }
      return '';
    };
    const mime = getMimeType();
    console.log('[VIDEO] Using mimeType:', mime);
    let recorder;
    try {
      recorder = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : {});
    } catch (error) {
      console.error('[VIDEO] MediaRecorder init failed:', error);
      if (latestRef.current.isEnding) finalizeMeeting();
      return false;
    }

    isRecordingRef.current = true;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = async () => {
      isRecordingRef.current = false;
      setIsRecording(false);
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      chunksRef.current = [];
      if (!blob.size) {
        if (latestRef.current.isEnding) await finalizeMeeting();
        return;
      }
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const base64data = result.includes(',') ? result.split(',')[1] : '';
        if (!base64data) {
          if (latestRef.current.isEnding) await finalizeMeeting();
          return;
        }
        try {
          const res = await fetch('http://localhost:5000/exam/upload-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, videoBase64: base64data })
          });
          const data = await res.json();
          console.log('[VIDEO] Upload success:', data.videoUrl);
          if (latestRef.current.isEnding) {
            await finalizeMeeting();
          }
        } catch (err) {
          console.error('Video upload failed:', err);
          if (latestRef.current.isEnding) await finalizeMeeting();
        }
      };
    };
    try {
      recorder.start(1000);
    } catch (e) {
      console.error('[VIDEO] MediaRecorder start failed, retrying with default mime...', e);
      try {
        recorder.start();
      } catch (retryErr) {
        console.error('[VIDEO] MediaRecorder retry failed:', retryErr);
        isRecordingRef.current = false;
        if (latestRef.current.isEnding) finalizeMeeting();
        return false;
      }
    }
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
    if (socket) {
      socket.emit('recording-status', {
        sessionId,
        isRecording: true,
        timestamp: new Date().toISOString()
      });
    }
    if (!silent) {
      showBanner('Auto-recording started due to persistent violations.', 5000);
    }
    return true;
  }, [finalizeMeeting, sessionId, showBanner, socket]);

  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      isRecordingRef.current = false;
      setIsRecording(false);
      if (socket) {
        socket.emit('recording-status', {
          sessionId,
          isRecording: false,
          timestamp: new Date().toISOString()
        });
      }
      return true;
    }
    return false;
  }, [sessionId, socket]);

  const handleEnd = async () => {
    if (endRequestedRef.current) return;
    endRequestedRef.current = true;
    latestRef.current.isEnding = true;
    const activeRecorder = mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive';
    if (activeRecorder || isRecordingRef.current) {
      stopRecording();
      // the onstop callback will handle the final upload and redirection
      return;
    }

    const startedFallbackCapture = startRecording({ force: true, silent: true, reason: 'meeting_end' });
    if (startedFallbackCapture) {
      showBanner('Saving final meeting recording…', 2200);
      endRecordingTimeoutRef.current = setTimeout(() => {
        endRecordingTimeoutRef.current = null;
        const hasActiveRecorder = mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive';
        if (hasActiveRecorder) {
          stopRecording();
        } else {
          finalizeMeeting();
        }
      }, 1800);
      return;
    }

    await finalizeMeeting();
  };

  useEffect(() => {
    if (!assistantScrollRef.current) return;
    assistantScrollRef.current.scrollTop = assistantScrollRef.current.scrollHeight;
  }, [assistantMessages, assistantLoading]);

  const sendAssistantMessage = useCallback(async (rawText) => {
    const text = String(rawText || '').trim();
    if (!text || assistantLoading) return;

    const userEntry = { role: 'user', text, timestamp: new Date().toISOString() };
    const requestHistory = [...assistantMessages, userEntry].slice(-10);
    setAssistantMessages(requestHistory);
    setAssistantInput('');
    setAssistantLoading(true);

    try {
      const response = await fetch('http://localhost:5000/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: requestHistory.map(msg => ({ role: msg.role, text: msg.text })),
          sessionId,
          candidateId,
          examId: localStorage.getItem('examId') || '',
          metrics: {
            severity: metrics.severity,
            riskScore: metrics.riskScore,
            signals: metrics.signals
          }
        })
      });

      const payload = await response.json().catch(() => ({}));
      const replyText = typeof payload.reply === 'string' && payload.reply.trim()
        ? payload.reply.trim()
        : (payload.error ? `Assistant unavailable: ${payload.error}` : 'Assistant could not respond right now.');
      const assistantEntry = { role: 'assistant', text: replyText, timestamp: new Date().toISOString() };
      setAssistantMessages(prev => [...prev, assistantEntry].slice(-14));
      if (assistantVoiceEnabled) {
        await playSpokenText(replyText);
      }
    } catch (error) {
      const fallbackText = 'I am unable to connect right now. Please inform the host and try again.';
      setAssistantMessages(prev => [...prev, { role: 'assistant', text: fallbackText, timestamp: new Date().toISOString() }].slice(-14));
      if (assistantVoiceEnabled) {
        await playSpokenText(fallbackText);
      }
    } finally {
      setAssistantLoading(false);
    }
  }, [
    assistantLoading,
    assistantMessages,
    assistantVoiceEnabled,
    candidateId,
    metrics.riskScore,
    metrics.severity,
    metrics.signals,
    playSpokenText,
    sessionId
  ]);

  const handleAssistantQuickAction = useCallback((type) => {
    const templates = {
      stop: 'I want to stop the exam. Tell me the safe steps.',
      issue: 'I have a technical issue in meeting and camera/audio. Help me fix it quickly.',
      help: 'I need help using DIGICLASS options during exam.'
    };
    const template = templates[type] || templates.help;
    sendAssistantMessage(template);
  }, [sendAssistantMessage]);

  const handleAssistantSubmit = useCallback(() => {
    sendAssistantMessage(assistantInput);
  }, [assistantInput, sendAssistantMessage]);

  const getPulseClass = () => metrics.severity === 'CRITICAL' ? 'pulse-red' : metrics.severity === 'WARNING' ? 'pulse-orange' : 'pulse-green';
  const phoneDetected = metrics.signals.includes('PHONE_DETECTED');
  const unidentifiableDetected = metrics.signals.includes('UNIDENTIFIABLE_OBJECT') || metrics.signals.includes('BOOK_DETECTED');

  return (
    <div className="meeting-layout">
      <div className="video-stage">
        <video ref={setVideoRef} className="main-video" autoPlay muted playsInline style={{ filter: videoActive ? 'none' : 'blur(20px)' }} />
        <canvas ref={canvasRef} width={640} height={480} className="meeting-canvas" />

        {/* ── Tab Switch / AI Tool Warning Banner ── */}
        {tabWarning && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
            background: 'linear-gradient(135deg, #c0392b, #8e1a0e)',
            color: '#fff', padding: '14px 20px',
            fontSize: 15, fontWeight: 'bold',
            display: 'flex', alignItems: 'center', gap: 12,
            boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
            animation: 'pulse-border 0.5s ease-in-out 3'
          }}>
            <span style={{ fontSize: 22 }}>🚨</span>
            <span style={{ flex: 1 }}>{tabWarning}</span>
            <button onClick={() => setTabWarning(null)}
              style={{
                background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff',
                borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12
              }}>Dismiss</button>
          </div>
        )}

        {cameraError && (
          <div style={{ position: 'absolute', top: 20, left: 20, right: 20, color: '#fff', background: 'rgba(0,0,0,0.9)', padding: 20, borderRadius: 8, fontSize: 14, zIndex: 10 }}>
            <div style={{ marginBottom: 12 }}>{cameraError}</div>
            <button type="button" onClick={handleRetryCamera} style={{ padding: '10px 20px', background: 'var(--zoom-blue)', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
              Retry camera
            </button>
          </div>
        )}
        {!meetingStream && !cameraError && (
          <div style={{ position: 'absolute', color: 'rgba(255,255,255,0.8)', fontSize: 18 }}>Starting camera...</div>
        )}
        {!videoActive && meetingStream && <div style={{ position: 'absolute', color: 'white', fontSize: '24px' }}>Video Paused</div>}
        {showCalculator && (
          <div className="meeting-calculator">
            <div className="calculator-head">
              <span>In-Meeting Calculator</span>
              <button type="button" onClick={() => setShowCalculator(false)}>X</button>
            </div>
            <div className="calculator-display">{calcDisplay}</div>
            <div className="calculator-grid">
              {['7', '8', '9', '/',
                '4', '5', '6', '*',
                '1', '2', '3', '-',
                '0', '.', '%', '+'].map(value => (
                  <button key={value} type="button" onClick={() => appendCalcValue(value)}>
                    {value}
                  </button>
                ))}
            </div>
            <div className="calculator-actions">
              <button type="button" onClick={clearCalculator}>Clear</button>
              <button type="button" onClick={backspaceCalculator}>Back</button>
              <button type="button" onClick={evaluateCalculator} className="eq">=</button>
            </div>
          </div>
        )}
      </div>

      {sidebarOpen && (
        <div className="meeting-sidebar">
          <div className="sidebar-header">
            <span>AI Proctoring Insights</span>
            <button onClick={() => setSidebarOpen(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}>✕</button>
          </div>
          <div className="sidebar-content">
            <div className="metric-row">
              <span className="label">Meeting Status</span>
              <span className="value" style={{ color: 'var(--zoom-success)' }}>● Secure</span>
            </div>
            <div className="metric-row">
              <span className="label">Risk Score</span>
              <span className="value" style={{ color: metrics.severity === 'OK' ? 'var(--zoom-success)' : 'var(--zoom-danger)' }}>
                {(metrics.riskScore * 100).toFixed(1)}%
              </span>
            </div>
            <div className="metric-row">
              <span className="label">Gaze Direction</span>
              <span className="value">{metrics.dir}</span>
            </div>
            <div className="metric-row">
              <span className="label">Participants</span>
              <span className="value">{metrics.faceCount} Detected</span>
            </div>
            <div className="metric-row">
              <span className="label">Phone Detection</span>
              <span className="value" style={{ color: phoneDetected ? 'var(--zoom-danger)' : 'var(--zoom-success)' }}>
                {phoneDetected ? 'Detected' : 'Clear'}
              </span>
            </div>
            <div className="metric-row">
              <span className="label">Object Check</span>
              <span className="value" style={{ color: unidentifiableDetected ? 'var(--zoom-warning)' : 'var(--zoom-success)' }}>
                {unidentifiableDetected ? 'Suspicious Object' : 'Clear'}
              </span>
            </div>
            {lastComfortRequest && (
              <div className="metric-row">
                <span className="label">Last Request</span>
                <span className="value" style={{ color: 'var(--zoom-blue)' }}>{lastComfortRequest}</span>
              </div>
            )}
            <div className="meeting-quick-controls">
              <button type="button" onClick={() => requestComfortOption('washroom')}>Washroom</button>
              <button type="button" onClick={() => requestComfortOption('water')}>Water</button>
              <button type="button" onClick={() => setShowCalculator(v => !v)}>
                {showCalculator ? 'Hide Calculator' : 'Calculator'}
              </button>
              <button type="button" className="danger" onClick={handleEnd}>End Meeting</button>
            </div>
            <div className="assistant-panel">
              <div className="assistant-head">
                <span>DIGICLASS Help Bot</span>
                <button
                  type="button"
                  className={`assistant-voice-toggle ${assistantVoiceEnabled ? 'on' : ''}`}
                  onClick={() => setAssistantVoiceEnabled(v => !v)}
                  title={assistantVoiceEnabled ? 'Voice replies ON' : 'Voice replies OFF'}
                >
                  {assistantVoiceEnabled ? 'Voice On' : 'Voice Off'}
                </button>
              </div>
              <div className="assistant-quick-actions">
                <button type="button" onClick={() => handleAssistantQuickAction('help')}>Need Help</button>
                <button type="button" onClick={() => handleAssistantQuickAction('issue')}>Technical Issue</button>
                <button type="button" onClick={() => handleAssistantQuickAction('stop')}>Stop Exam</button>
              </div>
              <div className="assistant-messages" ref={assistantScrollRef}>
                {assistantMessages.map((msg, idx) => (
                  <div key={`${msg.role}-${idx}-${msg.timestamp || ''}`} className={`assistant-message ${msg.role === 'user' ? 'user' : 'bot'}`}>
                    {msg.text}
                  </div>
                ))}
                {assistantLoading && (
                  <div className="assistant-message bot">Thinking...</div>
                )}
              </div>
              <div className="assistant-input-wrap">
                <input
                  type="text"
                  value={assistantInput}
                  onChange={e => setAssistantInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAssistantSubmit();
                    }
                  }}
                  placeholder="Ask for help..."
                  disabled={assistantLoading}
                />
                <button type="button" onClick={handleAssistantSubmit} disabled={assistantLoading || !assistantInput.trim()}>
                  {assistantLoading ? '...' : 'Send'}
                </button>
              </div>
            </div>
            {/* Tab switch & AI tool counters */}
            <div className="metric-row" style={{ borderTop: '1px solid #333', paddingTop: 10, marginTop: 4 }}>
              <span className="label">🔁 Tab Switches</span>
              <span className="value" style={{ color: tabSwitchCount > 0 ? 'var(--zoom-danger)' : 'var(--zoom-success)' }}>
                {tabSwitchCount === 0 ? '✓ None' : `${tabSwitchCount} ⚠️`}
              </span>
            </div>
            <div className="metric-row">
              <span className="label">🤖 AI Tool</span>
              <span className="value" style={{ color: aiToolSuspected ? 'var(--zoom-danger)' : 'var(--zoom-success)' }}>
                {aiToolSuspected ? 'FLAGGED 🔴' : '✓ Not Detected'}
              </span>
            </div>

            <div style={{ marginTop: '20px', padding: '12px', background: 'rgba(45, 140, 255, 0.1)', borderRadius: '8px', border: '1px solid var(--zoom-blue)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--zoom-blue)' }}>HIGH ACCURACY MODE</span>
                <button
                  onClick={() => setHighAccuracy(!highAccuracy)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    border: 'none',
                    background: highAccuracy ? 'var(--zoom-blue)' : '#555',
                    color: '#fff',
                    fontSize: '10px',
                    cursor: 'pointer'
                  }}
                >
                  {highAccuracy ? 'ON' : 'OFF'}
                </button>
              </div>
              <p style={{ fontSize: '10px', marginTop: '6px', color: '#ccc' }}>
                Uses server-side Python AI for rigorous validation.
              </p>
            </div>

            <div style={{ marginTop: '20px' }}>
              <span style={{ fontSize: '11px', color: '#888' }}>MODEL STATUS</span>
              <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                <span className="signal-chip" style={{ background: window.FaceMesh ? 'rgba(0,255,0,0.1)' : 'rgba(255,0,0,0.1)', color: window.FaceMesh ? '#0f0' : '#f00' }}>FaceMesh</span>
                <span className="signal-chip" style={{ background: window.Pose ? 'rgba(0,255,0,0.1)' : 'rgba(255,0,0,0.1)', color: window.Pose ? '#0f0' : '#f00' }}>Pose</span>
                <span className="signal-chip" style={{ background: window.cocoSsd ? 'rgba(0,255,0,0.1)' : 'rgba(255,0,0,0.1)', color: window.cocoSsd ? '#0f0' : '#f00' }}>ObjectDet</span>
                <span className="signal-chip" style={{ background: highAccuracy ? 'rgba(0,255,0,0.1)' : 'rgba(128,128,128,0.1)', color: highAccuracy ? '#0f0' : '#888' }}>ServerAI</span>
              </div>
            </div>
            <div style={{ marginTop: '20px' }}>
              <span style={{ fontSize: '11px', color: '#888' }}>ACTIVE SIGNALS</span>
              <div style={{ marginTop: '10px' }}>
                {metrics.signals.length > 0 ? metrics.signals.map(s => (
                  <span key={s} className="signal-chip danger">{s.replace(/_/g, ' ')}</span>
                )) : <span className="signal-chip" style={{ color: 'var(--zoom-success)' }}>✓ No Violations</span>}
              </div>
            </div>
            <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', border: '1px solid #333' }}>
              <span style={{ fontSize: '11px', color: 'var(--zoom-blue)', fontWeight: 'bold' }}>🤖 AI ANALYSIS</span>
              <p style={{ fontSize: '13px', marginTop: '10px', color: '#eee', lineHeight: '1.4' }}>
                {metrics.aiInsight}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="meeting-toolbar" style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
        <div className="toolbar-left">
          <button className="tool-btn" onClick={() => setAudioActive(!audioActive)}>
            <span style={{ fontSize: '20px' }}>{audioActive ? '🎙️' : '🔇'}</span>
            <span>{audioActive ? 'Mute' : 'Unmute'}</span>
          </button>
          <button className="tool-btn" onClick={() => setVideoActive(!videoActive)}>
            <span style={{ fontSize: '20px' }}>{videoActive ? '📹' : '🚫'}</span>
            <span>{videoActive ? 'Stop Video' : 'Start Video'}</span>
          </button>
        </div>
        <div className="toolbar-center">
          <button className="tool-btn ai-shield-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <span style={{ fontSize: '24px' }}>🛡️</span>
            <span>AI Shield</span>
            <div className={`shield-pulse ${getPulseClass()}`} />
          </button>
          <button className="tool-btn" onClick={() => requestComfortOption('washroom')}>
            <span style={{ fontSize: '20px' }}>WC</span>
            <span>Washroom</span>
          </button>
          <button className="tool-btn" onClick={() => requestComfortOption('water')}>
            <span style={{ fontSize: '20px' }}>H2O</span>
            <span>Water</span>
          </button>
          <button className="tool-btn" onClick={() => setShowCalculator(v => !v)}>
            <span style={{ fontSize: '20px' }}>123</span>
            <span>{showCalculator ? 'Hide Calc' : 'Calculator'}</span>
          </button>
          <button className="tool-btn">
            <span style={{ fontSize: '20px' }}>👥</span>
            <span>Participants</span>
          </button>
          <button className="tool-btn">
            <span style={{ fontSize: '20px' }}>💬</span>
            <span>Chat</span>
          </button>
          <button className="tool-btn">
            <span style={{ fontSize: '20px' }}>⬆️</span>
            <span>Share</span>
          </button>
        </div>
        <div className="toolbar-right">
          <button className="tool-btn btn-leave"
            onClick={handleEnd}
            style={{ minWidth: '100px', background: 'var(--zoom-danger)', color: 'white', fontWeight: 'bold' }}
          >
            End Meeting
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TEACHER MONITOR (GALLERY VIEW)
// ─────────────────────────────────────────────────────────────
function TeacherMonitor({ socket, onOpenReport }) {
  const [students, setStudents] = useState({});
  useEffect(() => {
    if (!socket) return;
    socket.emit('join-exam', { sessionId: 'teacher-monitor', studentName: 'Proctor Host', isTeacher: true });

    const handleActiveSessions = (data) => {
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      if (!sessions.length) return;
      setStudents(prev => {
        const next = { ...prev };
        sessions.forEach(session => {
          if (!session.sessionId) return;
          const existing = next[session.sessionId] || {};
          next[session.sessionId] = {
            ...existing,
            ...session,
            alertHistory: existing.alertHistory || [],
            reportWarnings: Array.isArray(session.warningsTail) && session.warningsTail.length > 0
              ? session.warningsTail
              : (existing.reportWarnings || []),
            verificationEvidence: session.verificationEvidence || existing.verificationEvidence || null,
            recordingSavedAt: session.recordingSavedAt || existing.recordingSavedAt || null
          };
        });
        return next;
      });
    };

    const handleStudentAlert = (data) => {
      if (!data?.sessionId) return;
      setStudents(prev => {
        const existing = prev[data.sessionId] || {};
        const alertEntry = {
          timestamp: data.timestamp || new Date().toISOString(),
          reason: data.reason || 'Suspicious behavior',
          severity: data.severity || 'WARNING',
          riskScore: Number.isFinite(data.riskScore) ? data.riskScore : 0
        };
        return {
          ...prev,
          [data.sessionId]: {
            ...existing,
            ...data,
            sessionId: data.sessionId,
            sessionNumber: data.sessionNumber || existing.sessionNumber || null,
            verificationEvidence: data.verificationEvidence || existing.verificationEvidence || null,
            alertHistory: [alertEntry, ...(existing.alertHistory || [])].slice(0, 30),
            lastSeen: new Date().toLocaleTimeString(),
            status: 'Active'
          }
        };
      });
    };

    const handleComfortRequest = (data) => {
      if (!data?.sessionId) return;
      setStudents(prev => ({
        ...prev,
        [data.sessionId]: {
          ...prev[data.sessionId],
          sessionId: data.sessionId,
          sessionNumber: data.sessionNumber || prev[data.sessionId]?.sessionNumber || null,
          ...data,
          comfortRequests: [...(prev[data.sessionId]?.comfortRequests || []), data],
          lastSeen: new Date().toLocaleTimeString(),
          status: prev[data.sessionId]?.status || 'Active'
        }
      }));
    };

    const handleRecordingUpdate = (data) => {
      if (!data?.sessionId) return;
      setStudents(prev => ({
        ...prev,
        [data.sessionId]: {
          ...prev[data.sessionId],
          sessionId: data.sessionId,
          sessionNumber: data.sessionNumber || prev[data.sessionId]?.sessionNumber || null,
          studentId: data.studentId,
          studentName: data.studentName,
          videoUrl: data.videoUrl,
          recordingActive: data.recordingActive,
          recordingStartedAt: data.recordingStartedAt || prev[data.sessionId]?.recordingStartedAt,
          recordingSavedAt: data.recordingSavedAt || prev[data.sessionId]?.recordingSavedAt || null
        }
      }));
    };

    const handleSessionEnded = (data) => {
      if (!data?.sessionId) return;
      setStudents(prev => ({
        ...prev,
        [data.sessionId]: {
          ...prev[data.sessionId],
          ...data,
          sessionId: data.sessionId,
          sessionNumber: data.sessionNumber || prev[data.sessionId]?.sessionNumber || null,
          status: 'Ended'
        }
      }));

      fetch(`http://localhost:5000/exam/report/${data.sessionId}`)
        .then(async (response) => {
          if (!response.ok) throw new Error('Report unavailable');
          return response.json();
        })
        .then((report) => {
          setStudents(prev => ({
            ...prev,
            [data.sessionId]: {
              ...prev[data.sessionId],
              sessionId: data.sessionId,
              sessionNumber: report.sessionNumber || prev[data.sessionId]?.sessionNumber || null,
              videoUrl: report.videoUrl || prev[data.sessionId]?.videoUrl || null,
              finalAiAnalysis: report.finalAiAnalysis || prev[data.sessionId]?.finalAiAnalysis || null,
              finalAiInsight: report.finalAiAnalysis?.aiInsight || report.latestAiInsight || prev[data.sessionId]?.finalAiInsight || null,
              reportWarnings: Array.isArray(report.warnings) ? report.warnings : [],
              warningsRaised: report.warningsRaised,
              violationCount: report.violationCount,
              recordingActive: !!report.recordingActive,
              recordingStartedAt: report.recordingStartedAt || prev[data.sessionId]?.recordingStartedAt || null,
              recordingSavedAt: report.recordingSavedAt || prev[data.sessionId]?.recordingSavedAt || null,
              verification: report.verification || prev[data.sessionId]?.verification || null,
              verificationEvidence: report.verificationEvidence || prev[data.sessionId]?.verificationEvidence || null,
              averageRiskPercent: report.averageRiskPercent ?? prev[data.sessionId]?.averageRiskPercent ?? null,
              peakRiskPercent: report.peakRiskPercent ?? prev[data.sessionId]?.peakRiskPercent ?? null,
              startTime: report.startTime || prev[data.sessionId]?.startTime || null,
              endTime: report.endTime || prev[data.sessionId]?.endTime || null
            }
          }));
        })
        .catch(() => { });
    };

    socket.on('active-sessions', handleActiveSessions);
    socket.on('student-alert', handleStudentAlert);
    socket.on('student-comfort-request', handleComfortRequest);
    socket.on('student-recording-updated', handleRecordingUpdate);
    socket.on('session-ended', handleSessionEnded);

    return () => {
      socket.off('active-sessions', handleActiveSessions);
      socket.off('student-alert', handleStudentAlert);
      socket.off('student-comfort-request', handleComfortRequest);
      socket.off('student-recording-updated', handleRecordingUpdate);
      socket.off('session-ended', handleSessionEnded);
    };
  }, [socket]);

  return (
    <div className="host-gallery">
      {Object.values(students).map(s => (
        <div key={s.sessionId || s.studentId} className={`participant-card ${(s.severity || 'OK') !== 'OK' ? 'alert' : ''}`}>
          <div style={{ height: '160px', background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '40px', position: 'relative' }}>
            👤
            {(s.severity || 'OK') !== 'OK' && <div className="alert-badge">!</div>}
          </div>
          <div className="participant-info">
            <span style={{ fontWeight: 'bold' }}>{s.studentName}</span>
            <span style={{ color: s.status === 'Ended' ? '#888' : (s.severity === 'CRITICAL' ? 'var(--zoom-danger)' : s.severity === 'WARNING' ? 'var(--zoom-warning)' : 'var(--zoom-success)'), fontSize: '11px' }}>
              ● {s.status || 'Active'} ({s.severity || 'OK'})
            </span>
          </div>
          <div style={{ padding: '10px', borderTop: '1px solid #333' }}>
            <div style={{ fontSize: '10px', color: '#ffcc00', marginBottom: '4px' }}>
              {s.reason || s.finalAiInsight || 'No alerts yet'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: '#888' }}>{s.timestamp ? formatTimeOnly(s.timestamp) : (s.lastSeen || '--')}</span>
              {(s.recordingActive || s.videoUrl) && (
                <span className={`rec-dot ${s.recordingActive ? '' : 'rec-dot-saved'}`}>
                  {s.recordingActive ? 'REC ON' : 'REC SAVED'}
                </span>
              )}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#bbb' }}>
              Session: {s.sessionId || '--'}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#bbb' }}>
              Session No: {s.sessionNumber ?? '--'}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#bbb' }}>
              Exam ID: {s.examId || '--'} | Candidate: {s.studentId || s.studentName || '--'}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#9fd0ff' }}>
              Verification: Face {s.verification?.faceVerified ? '✓' : '✗'} | ID {s.verification?.idVerified ? '✓' : '✗'} | Env {s.verification?.envScanPassed ? '✓' : '✗'}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#bbb' }}>
              Violations: {s.violationCount || 0} | Peak Risk: {s.peakRiskPercent || (s.riskScore ? `${(Number(s.riskScore) * 100).toFixed(1)}%` : '--')}
            </div>
            <div style={{ marginTop: 8, padding: 8, borderRadius: 6, border: '1px solid #2a2a2a', background: 'rgba(255,255,255,0.03)', fontSize: 11, lineHeight: 1.45 }}>
              <strong>Host Details</strong>
              <div style={{ marginTop: 6 }}>Candidate: {s.studentId || s.candidateId || s.studentName || '--'}</div>
              <div>Exam ID: {s.examId || '--'}</div>
              <div>Session ID: {s.sessionId || '--'} | Session No: {s.sessionNumber ?? '--'}</div>
              <div>Start: {formatTimeOnly(s.startTime)} | End: {formatTimeOnly(s.endTime)}</div>
              <div>Verification Time: {formatTimeOnly(s.verificationEvidence?.verifiedAt)}</div>
              <div>Recording Started: {formatTimeOnly(s.recordingStartedAt)} | Recording Saved: {formatTimeOnly(s.recordingSavedAt)}</div>
              <div>Warnings: {s.warningsRaised ?? '--'} | Violations: {s.violationCount || 0}</div>
              <div>Average Risk: {s.averageRiskPercent ? `${s.averageRiskPercent}%` : '--'}</div>
            </div>
            {(s.verificationEvidence?.faceSnapshot || s.verificationEvidence?.idSnapshotUrl) && (
              <div style={{ marginTop: 8, padding: 8, borderRadius: 6, border: '1px solid #2a2a2a', background: 'rgba(159,208,255,0.07)', fontSize: 11 }}>
                <strong>Verification Evidence</strong>
                <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                  {s.verificationEvidence?.faceSnapshot && (
                    <a href={s.verificationEvidence.faceSnapshot} target="_blank" rel="noreferrer" style={{ color: '#9fd0ff', fontSize: 11 }}>
                      Face Snapshot
                    </a>
                  )}
                  {s.verificationEvidence?.idSnapshotUrl && (
                    <a href={s.verificationEvidence.idSnapshotUrl} target="_blank" rel="noreferrer" style={{ color: '#9fd0ff', fontSize: 11 }}>
                      ID Snapshot
                    </a>
                  )}
                </div>
              </div>
            )}
            {Array.isArray(s.comfortRequests) && s.comfortRequests.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--zoom-blue)' }}>
                Last comfort request: {s.comfortRequests[s.comfortRequests.length - 1]?.option}
              </div>
            )}
            {s.finalAiInsight && (
              <div style={{ marginTop: 8, padding: 8, borderRadius: 6, border: '1px solid #2a2a2a', background: 'rgba(255,255,255,0.04)', fontSize: 11, lineHeight: 1.4 }}>
                <strong>Final AI Analysis:</strong> {s.finalAiInsight}
                {s.finalAiAnalysis?.severity && (
                  <div style={{ marginTop: 6 }}>
                    Severity: {s.finalAiAnalysis.severity} | Risk: {Number.isFinite(s.finalAiAnalysis.riskScore) ? `${(s.finalAiAnalysis.riskScore * 100).toFixed(1)}%` : '--'}
                  </div>
                )}
                {Array.isArray(s.finalAiAnalysis?.signals) && s.finalAiAnalysis.signals.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    Signals: {s.finalAiAnalysis.signals.join(', ')}
                  </div>
                )}
              </div>
            )}
            {(() => {
              const timeline = Array.isArray(s.reportWarnings) && s.reportWarnings.length > 0
                ? s.reportWarnings.slice(-5).reverse()
                : Array.isArray(s.alertHistory)
                  ? s.alertHistory.slice(0, 5)
                  : [];
              if (!timeline.length) return null;
              return (
                <div style={{ marginTop: 8, padding: 8, borderRadius: 6, border: '1px solid #2a2a2a', background: 'rgba(255,255,255,0.03)' }}>
                  <strong style={{ fontSize: 11 }}>AI Violation Timeline</strong>
                  {timeline.map((entry, idx) => (
                    <div key={`${s.sessionId}-timeline-${idx}`} style={{ marginTop: 6, fontSize: 10, lineHeight: 1.35, color: '#ddd' }}>
                      [{formatTimeOnly(entry.timestamp)}] {entry.reason || entry.aiInsight || 'Violation detected'}
                    </div>
                  ))}
                </div>
              );
            })()}
            {s.videoUrl && (
              <a href={s.videoUrl} target="_blank" rel="noreferrer" className="teacher-video-link">
                View Recording
              </a>
            )}
            {s.sessionId && onOpenReport && (
              <button
                type="button"
                className="teacher-report-btn"
                onClick={() => onOpenReport(s.sessionId, s.sessionNumber ?? null)}
              >
                Open AI Report
              </button>
            )}
          </div>
        </div>
      ))}
      {Object.keys(students).length === 0 && <div style={{ color: '#888', padding: '40px', textAlign: 'center', width: '100%' }}>Waiting for students to join meeting...</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD & REPORTS (Simple Zoom Style)
// ─────────────────────────────────────────────────────────────
function Dashboard() {
  return <div style={{ padding: '40px' }}><h2>Meeting Intelligence Dashboard</h2><p>All AI Services: Active</p></div>;
}

function Reports({ socket, defaultSessionId = '', defaultSessionNumber = null, isProctorHost = false }) {
  const [reportSessionId, setReportSessionId] = useState('');
  const [recentSessions, setRecentSessions] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const loadRecentSessions = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:5000/exam/sessions');
      if (!response.ok) return;
      const data = await response.json();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      setRecentSessions(sessions);
    } catch (_) { }
  }, []);

  const loadReportBySessionId = useCallback(async (sessionIdToLoad) => {
    const targetSessionId = String(sessionIdToLoad || '').trim();
    if (!targetSessionId) return;
    setLoading(true);
    try {
      const response = await fetch(`http://localhost:5000/exam/report/${targetSessionId}`);
      if (!response.ok) throw new Error('Report not found');
      const data = await response.json();
      setReport(data);
      setReportSessionId(targetSessionId);
    } catch (error) {
      alert(error.message || 'Could not load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecentSessions();
  }, [loadRecentSessions]);

  useEffect(() => {
    if (!socket) return;
    const refreshSessions = () => { loadRecentSessions(); };
    socket.on('student-alert', refreshSessions);
    socket.on('session-ended', refreshSessions);
    socket.on('active-sessions', refreshSessions);
    return () => {
      socket.off('student-alert', refreshSessions);
      socket.off('session-ended', refreshSessions);
      socket.off('active-sessions', refreshSessions);
    };
  }, [loadRecentSessions, socket]);

  useEffect(() => {
    if (defaultSessionId && defaultSessionId !== reportSessionId) {
      setReportSessionId(defaultSessionId);
      setReport(null);
    }
  }, [defaultSessionId, reportSessionId]);

  useEffect(() => {
    if (reportSessionId) return;
    const localSessionId = localStorage.getItem('sessionId') || '';
    const fallbackSessionId = defaultSessionId || localSessionId || recentSessions[0]?.sessionId || '';
    if (fallbackSessionId) setReportSessionId(fallbackSessionId);
  }, [defaultSessionId, recentSessions, reportSessionId]);

  useEffect(() => {
    if (!isProctorHost || !defaultSessionId) return;
    loadReportBySessionId(defaultSessionId);
  }, [defaultSessionId, isProctorHost, loadReportBySessionId]);

  return (
    <div className="reports-container" style={{ padding: '40px', maxWidth: '900px', margin: '0 auto' }}>
      <div style={{ marginBottom: '10px', color: '#666', fontSize: '12px' }}>
        {defaultSessionNumber
          ? `Default Session No: ${defaultSessionNumber}`
          : 'Session ID is auto-filled from your latest/selected session.'}
      </div>
      <div className="search-box" style={{ background: '#fff', padding: '20px', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', marginBottom: '30px', display: 'flex', gap: '10px' }}>
        <input
          type="text"
          placeholder="Session ID (auto-filled)"
          value={reportSessionId}
          onChange={e => setReportSessionId(e.target.value)}
          style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid #ddd' }}
        />
        <button onClick={() => loadReportBySessionId(reportSessionId)} disabled={loading} style={{ background: 'var(--zoom-blue)', color: '#fff', border: 'none', borderRadius: '8px', padding: '0 25px', cursor: 'pointer', fontWeight: 'bold' }}>
          {loading ? 'Fetching...' : 'Get Audit Report'}
        </button>
      </div>

      {!report && recentSessions.length > 0 && (
        <div style={{ marginBottom: '30px', background: '#fff', padding: '20px', borderRadius: '12px' }}>
          <h4 style={{ color: '#333', marginBottom: '15px' }}>Recent Sessions</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
            {recentSessions.map(s => (
              <button key={s.sessionId} onClick={() => { setReportSessionId(s.sessionId); }}
                style={{ background: '#f0f4ff', border: '1px solid #d0d7ff', padding: '10px', borderRadius: '8px', color: 'var(--zoom-blue)', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ fontWeight: 'bold' }}>{s.candidateId}</div>
                <div style={{ fontSize: '10px', color: '#888' }}>
                  Session No: {s.sessionNumber ?? '--'} | {formatTimeOnly(s.endTime || s.startTime)}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {report && (
        <div className="report-result" style={{ background: '#fff', padding: '30px', borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.1)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
            <div>
              <h2 style={{ color: '#000', marginBottom: '4px' }}>Proctoring Audit: {report.candidateId}</h2>
              <p style={{ color: '#666', fontSize: '13px' }}>
                Exam: {report.examId} | Session: {report.sessionId} | Session No: {report.sessionNumber ?? '--'}
              </p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '24px', fontWeight: 'bold', color: Number(report.averageRiskPercent) > 60 ? 'var(--zoom-danger)' : 'var(--zoom-success)' }}>
                {report.averageRiskPercent}% Risk
              </div>
              <span style={{ fontSize: '12px', color: '#999' }}>Average Confidence Score</span>
            </div>
          </div>

          {report.videoUrl && (
            <div style={{ marginBottom: '30px' }}>
              <h3 style={{ fontSize: '16px', marginBottom: '12px', color: '#333' }}>⏺️ Video Evidence (Auto-Recorded)</h3>
              <video src={report.videoUrl} controls style={{ width: '100%', borderRadius: '8px', background: '#000' }} />
              <p style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>Recording triggered after 5 consecutive violations.</p>
            </div>
          )}

          <div style={{ marginBottom: '24px', padding: '12px 14px', borderRadius: '8px', background: '#fff7e6', border: '1px solid #ffd591', color: '#8a6d3b', fontSize: '12px' }}>
            AI violation analysis includes exact timestamps for each warning event.
          </div>

          <div style={{ marginBottom: '20px', padding: '12px 14px', borderRadius: '8px', background: '#f5f9ff', border: '1px solid #d7e6ff', color: '#244a7c', fontSize: '12px', lineHeight: 1.6 }}>
            <strong>Credentials</strong><br />
            Candidate: {report.candidateId || '--'}<br />
            Exam ID: {report.examId || '--'}<br />
            Verification: Face {report.verification?.faceVerified ? '✓' : '✗'} | ID {report.verification?.idVerified ? '✓' : '✗'} | Env {report.verification?.envScanPassed ? '✓' : '✗'}<br />
            Verified At: {formatTimeOnly(report.verificationEvidence?.verifiedAt)}<br />
            Start: {formatTimeOnly(report.startTime)} | End: {formatTimeOnly(report.endTime)}<br />
            Recording Started: {formatTimeOnly(report.recordingStartedAt)} | Recording Saved: {formatTimeOnly(report.recordingSavedAt)}
          </div>

          {(report.verificationEvidence?.faceSnapshot || report.verificationEvidence?.idSnapshotUrl) && (
            <div style={{ marginBottom: '20px', padding: '12px 14px', borderRadius: '8px', background: '#eef6ff', border: '1px solid #c5dcff', color: '#244a7c', fontSize: '12px' }}>
              <strong>Verification Evidence</strong>
              <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {report.verificationEvidence?.faceSnapshot && (
                  <a href={report.verificationEvidence.faceSnapshot} target="_blank" rel="noreferrer" style={{ color: '#1f5fbf' }}>
                    Open Face Snapshot
                  </a>
                )}
                {report.verificationEvidence?.idSnapshotUrl && (
                  <a href={report.verificationEvidence.idSnapshotUrl} target="_blank" rel="noreferrer" style={{ color: '#1f5fbf' }}>
                    Open ID Snapshot
                  </a>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '30px' }}>
            <div style={{ padding: '15px', background: '#f8f9fa', borderRadius: '8px' }}>
              <p style={{ fontSize: '12px', color: '#888' }}>Total Warnings</p>
              <p style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{report.warningsRaised}</p>
            </div>
            <div style={{ padding: '15px', background: '#f8f9fa', borderRadius: '8px' }}>
              <p style={{ fontSize: '12px', color: '#888' }}>Peak Risk</p>
              <p style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{report.peakRiskPercent}%</p>
            </div>
          </div>

          <h3 style={{ fontSize: '16px', marginBottom: '15px', color: '#333' }}>Detailed Violation Log</h3>
          <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
            {Array.isArray(report.warnings) && report.warnings.length > 0 ? (
              report.warnings.map((w, i) => (
                <div key={i} style={{ padding: '12px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 'bold', color: w.severity === 'CRITICAL' ? '#f00' : '#f80', fontSize: '13px' }}>{w.reason}</div>
                    <div style={{ fontSize: '11px', color: '#999' }}>Frame {w.frame}</div>
                  </div>
                  <div style={{ fontSize: '11px', color: '#999' }}>{formatTimeOnly(w.timestamp)}</div>
                </div>
              ))
            ) : (
              <div style={{ padding: '12px', color: '#999', fontSize: '12px' }}>No timestamped violations were recorded for this session.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;



