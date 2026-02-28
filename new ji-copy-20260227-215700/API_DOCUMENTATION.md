# AI-Powered Proctored Exam Platform - API Documentation

## 🎯 Platform Overview
The AI-Powered Proctored Exam Platform is a comprehensive solution for secure, privacy-conscious online proctoring. All services are running on localhost with the following architecture:

```
┌─────────────────────────────────────────────────────────────┐
│          Frontend (React) - Port 3000 (Optional)           │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│     Backend API (Node.js/Express) - Port 5000              │
│  • Exam orchestration, session management, reporting        │
└────┬────────┬────────────┬────────────┬────────────┬────────┘
     │        │            │            │            │
     ▼        ▼            ▼            ▼            ▼
  Port 8000  Port 8001  Port 8002   Port 8003   (Database)
Pre-Exam   Live Mon   Intelligent  Post-Exam   MongoDB
Verifi.    itoring    Flagging     Audit       (Optional)
```

---

## 🚀 Running Services

### Pre-Exam Verification Service (Port 8000)
**Purpose:** Face recognition, ID validation, and environment scanning

#### Endpoints:
```
POST /verify-face
  - Upload: image file
  - Returns: face_detected (bool), num_faces (int)
  
POST /verify-id
  - Upload: image file
  - Returns: id_valid (bool), details (str)
  
POST /scan-environment
  - Upload: image file
  - Returns: num_faces (int), environment_ok (bool)
```

#### Example Usage:
```bash
# Check if a face is detected
curl -X POST -F "image=@photo.jpg" http://localhost:8000/verify-face

# Validate ID document
curl -X POST -F "image=@id.jpg" http://localhost:8000/verify-id

# Scan environment for multiple faces
curl -X POST -F "image=@room.jpg" http://localhost:8000/scan-environment
```

---

### Live Monitoring Service (Port 8001)
**Purpose:** Real-time anomaly detection during exams

#### Endpoints:
```
POST /monitor-faces
  - Upload: image file
  - Returns: num_faces (int), multiple_faces (bool)
  
POST /monitor-eye
  - Upload: image file
  - Returns: num_eyes (int), eye_movement_detected (bool)
  
POST /monitor-audio
  - Upload: audio file
  - Returns: audio_anomaly (bool), details (str)
  
POST /monitor-tab
  - Send: JSON {tab_switch: bool}
  - Returns: tab_switch_detected (bool)
```

#### Example Usage:
```bash
# Monitor for multiple faces
curl -X POST -F "image=@frame.jpg" http://localhost:8001/monitor-faces

# Detect eye movement
curl -X POST -F "image=@face.jpg" http://localhost:8001/monitor-eye

# Check for audio anomalies
curl -X POST -F "audio=@recording.wav" http://localhost:8001/monitor-audio

# Log tab switch event
curl -X POST -H "Content-Type: application/json" \
  -d '{"tab_switch": true}' http://localhost:8001/monitor-tab
```

---

### Intelligent Flagging Service (Port 8002)
**Purpose:** AI-driven risk scoring and violation flagging

#### Endpoints:
```
POST /risk-score
  - Input: JSON with anomaly booleans
  - {
      "multiple_faces": bool,
      "eye_movement": bool,
      "audio_anomaly": bool,
      "tab_switch": bool
    }
  - Returns: risk_score (0-1), flag (string), evidence (array)
```

#### Risk Scoring:
- **Multiple Faces:** 0.4 weight
- **Eye Movement:** 0.2 weight
- **Audio Anomaly:** 0.2 weight
- **Tab Switch:** 0.2 weight

#### Flags:
- `high-risk`: Score ≥ 0.7
- `medium-risk`: Score ≥ 0.4 and < 0.7
- `low-risk`: Score < 0.4

#### Example Usage:
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "multiple_faces": false,
    "eye_movement": true,
    "audio_anomaly": false,
    "tab_switch": true
  }' http://localhost:8002/risk-score
```

#### Example Response:
```json
{
  "risk_score": 0.4,
  "flag": "medium-risk",
  "evidence": [
    {
      "anomaly": "eye_movement",
      "timestamp": "2026-02-21T10:30:00.000Z"
    },
    {
      "anomaly": "tab_switch",
      "timestamp": "2026-02-21T10:30:02.000Z"
    }
  ]
}
```

---

### Post-Exam Audit Service (Port 8003)
**Purpose:** Generate timestamped proctoring reports

#### Endpoints:
```
POST /generate-report
  - Input: JSON with exam session data
  - {
      "candidate_id": string,
      "exam_id": string,
      "risk_score": float,
      "flag": string,
      "evidence": array
    }
  - Returns: report (object), status (string)
```

#### Example Usage:
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "candidate_id": "CAND_001",
    "exam_id": "EXAM_002",
    "risk_score": 0.65,
    "flag": "medium-risk",
    "evidence": [
      {"anomaly": "tab_switch", "timestamp": "2026-02-21T10:30:02.000Z"}
    ]
  }' http://localhost:8003/generate-report
```

#### Example Response:
```json
{
  "report": {
    "candidate_id": "CAND_001",
    "exam_id": "EXAM_002",
    "risk_score": 0.65,
    "flag": "medium-risk",
    "evidence": [...],
    "generated_at": "2026-02-21T10:35:00.000Z"
  },
  "status": "success"
}
```

---

### Backend API (Port 5000)
**Purpose:** Orchestrate exam sessions, logs, and proctoring workflow

#### Endpoints:
```
GET /
  - Returns: Service status and available endpoints
  
POST /exam/start
  - Input: {candidateId: string, examId: string}
  - Returns: sessionId, startTime
  
POST /exam/event
  - Input: {sessionId: string, eventType: string, data: object}
  - Returns: confirmation with timestamp
  
POST /exam/end
  - Input: {sessionId: string}
  - Returns: endTime, reportUrl
  
GET /exam/report/:sessionId
  - Returns: Proctoring report for the session
```

#### Example Usage:
```bash
# Start an exam session
curl -X POST -H "Content-Type: application/json" \
  -d '{"candidateId": "CAND_001", "examId": "EXAM_002"}' \
  http://localhost:5000/exam/start

# Log a monitoring event
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session_1708500000000",
    "eventType": "anomaly_detected",
    "data": {"type": "tab_switch"}
  }' http://localhost:5000/exam/event

# End the exam session
curl -X POST -H "Content-Type: application/json" \
  -d '{"sessionId": "session_1708500000000"}' \
  http://localhost:5000/exam/end

# Retrieve the proctoring report
curl http://localhost:5000/exam/report/session_1708500000000
```

---

## 🔄 Complete Exam Workflow Example

### 1. Pre-Exam (Verification Phase)
```bash
# Step 1: Verify candidate's face
curl -X POST -F "image=@selfie.jpg" http://localhost:8000/verify-face

# Step 2: Verify ID document
curl -X POST -F "image=@passport.jpg" http://localhost:8000/verify-id

# Step 3: Scan the exam environment
curl -X POST -F "image=@room_scan.jpg" http://localhost:8000/scan-environment
```

### 2. Start Exam Session
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"candidateId": "CAND_001", "examId": "EXAM_002"}' \
  http://localhost:5000/exam/start
# → Returns: sessionId
```

### 3. During Exam (Live Monitoring)
```bash
# Every 5-10 seconds, capture and analyze:

# Monitor participant
curl -X POST -F "image=@frame.jpg" http://localhost:8001/monitor-faces
curl -X POST -F "image=@face.jpg" http://localhost:8001/monitor-eye

# Check for audio issues
curl -X POST -F "audio=@audio_chunk.wav" http://localhost:8001/monitor-audio

# Log tab switch events
curl -X POST -H "Content-Type: application/json" \
  -d '{"tab_switch": true}' http://localhost:8001/monitor-tab
```

### 4. Risk Scoring (Real-time)
```bash
# Aggregate anomalies and compute risk score
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "multiple_faces": false,
    "eye_movement": true,
    "audio_anomaly": false,
    "tab_switch": true
  }' http://localhost:8002/risk-score
# → Returns: risk_score, flag, evidence
```

### 5. End Exam & Generate Report
```bash
# End the exam session
curl -X POST -H "Content-Type: application/json" \
  -d '{"sessionId": "session_1708500000000"}' \
  http://localhost:5000/exam/end

# Generate comprehensive audit report
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "candidate_id": "CAND_001",
    "exam_id": "EXAM_002",
    "risk_score": 0.4,
    "flag": "medium-risk",
    "evidence": [...]
  }' http://localhost:8003/generate-report

# Retrieve final report
curl http://localhost:5000/exam/report/session_1708500000000
```

---

## 📊 System Architecture

### Components:
1. **Pre-Exam Verification** (Python/Flask)
   - Face recognition via OpenCV
   - ID validation (placeholder for OCR)
   - Environment scan for suspicious activity

2. **Live Monitoring** (Python/Flask)
   - Face/eye detection
   - Audio anomaly detection
   - Tab switch tracking
   - Real-time event logging

3. **Intelligent Flagging** (Python/Flask)
   - Weighted anomaly scoring
   - Risk level classification
   - Evidence collection

4. **Post-Exam Audit** (Python/Flask)
   - Report generation
   - Timestamp tracking
   - Evidence archival

5. **Backend API Orchestrator** (Node.js/Express)
   - Session management
   - Event routing
   - Report retrieval

---

## 🔐 Security & Privacy Features

- **Face Recognition:** Local processing (minimal data exposure)
- **Privacy-First Design:** Evidence is timestamped but minimal storage
- **False Positive Reduction:** Weighted scoring prevents overflags
- **Audit Trail:** Complete evidence log for review

---

## 📝 Next Steps

1. **Integrate Advanced ML Models:**
   - Use DeepFace or FaceNet for higher accuracy
   - Implement eye-gaze tracking
   - Add speech detection

2. **Frontend Application:**
   - React app for candidate interface
   - Institution dashboard for review
   - Real-time monitoring display

3. **Database Integration:**
   - Store MongoDB URI for persistent data
   - Archive reports with media evidence
   - User/exam management

4. **Deployment:**
   - Docker containerization
   - Kubernetes orchestration
   - Cloud hosting (AWS/Azure/GCP)

---

## 📞 Support

For issues or feature requests, refer to the respective service README files in each folder.

**Platform Status:** All services running and operational ✓
**Last Check:** 2026-02-21
