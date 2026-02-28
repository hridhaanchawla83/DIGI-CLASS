# 🎓 AI-Powered Proctored Exam Platform - Quick Start Guide

## ✅ Platform Status: ALL SERVICES RUNNING

Your AI-powered proctored exam platform is now fully operational with all services running on localhost!

---

## 🌐 Service Endpoints (All Running)

| Service | URL | Port | Purpose |
|---------|-----|------|---------|
| **Pre-Exam Verification** | http://localhost:8000 | 8000 | Face recognition, ID validation, environment scan |
| **Live Monitoring** | http://localhost:8001 | 8001 | Real-time anomaly detection (faces, eyes, audio, tabs) |
| **Intelligent Flagging** | http://localhost:8002 | 8002 | AI risk scoring with evidence tracking |
| **Post-Exam Audit** | http://localhost:8003 | 8003 | Auto-generated proctoring reports |
| **Backend API** | http://localhost:5000 | 5000 | Session management and orchestration |

---

## 🚀 Quick Test

### Test All Services:
```bash
python test_services.py
```

### Test Individual Endpoints:

**1. Pre-Exam Verification:**
```bash
curl -X POST -F "image=@photo.jpg" http://localhost:8000/verify-face
```

**2. Live Monitoring:**
```bash
curl -X POST -F "image=@frame.jpg" http://localhost:8001/monitor-faces
```

**3. Intelligent Flagging:**
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"multiple_faces": false, "eye_movement": true, "audio_anomaly": false, "tab_switch": true}' \
  http://localhost:8002/risk-score
```

**4. Post-Exam Audit:**
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"candidate_id": "C001", "exam_id": "E002", "risk_score": 0.4, "flag": "medium-risk", "evidence": []}' \
  http://localhost:8003/generate-report
```

**5. Backend API:**
```bash
curl http://localhost:5000
curl -X POST -H "Content-Type: application/json" \
  -d '{"candidateId": "C001", "examId": "E002"}' \
  http://localhost:5000/exam/start
```

---

## 📁 Project Structure

```
ai-powered-proctored-exam/
├── frontend/                  # React UI (to be implemented)
│   ├── package.json
│   └── App.js
├── backend/                   # Node.js/Express API
│   ├── package.json
│   └── index.js              # Running on port 5000
├── ai-services/              # Python Microservices
│   ├── pre_exam_verification.py    # Port 8000
│   ├── live_monitoring.py          # Port 8001
│   ├── intelligent_flagging.py     # Port 8002
│   ├── post_exam_audit.py         # Port 8003
│   └── [README files for each]
├── database/                  # MongoDB setup (optional)
├── .venv/                    # Python virtual environment
├── README.md                  # Main documentation
├── API_DOCUMENTATION.md       # Detailed API guide
├── QUICKSTART.md             # This file
└── test_services.py          # Service health check script
```

---

## 🔑 Core Features Implemented

### ✓ Pre-Exam Verification
- Face recognition via OpenCV
- ID document validation
- Environment scanning for suspicious objects/people

### ✓ Live Monitoring
- Real-time face detection
- Eye movement tracking
- Audio anomaly detection
- Tab switch detection

### ✓ Intelligent Flagging
- Weighted anomaly scoring system
- Three-tier risk classification (low/medium/high)
- Timestamped evidence collection
- False positive reduction

### ✓ Post-Exam Audit
- Auto-generated proctoring reports
- Complete evidence history
- Timestamped events
- Report retrieval API

### ✓ Backend Orchestration
- Session management
- Event routing and logging
- Report generation coordination

---

## 🎯 Typical Exam Workflow

### Step 1: Pre-Exam (Verification)
```
Candidate uploads:
- Selfie (face recognition)
- ID document (validation)
- Room scan (environment check)
```

### Step 2: Start Exam
```
POST /exam/start
→ Returns session ID & start timestamp
```

### Step 3: Monitor Exam (Continuous)
```
Every 5-10 seconds:
- Capture webcam frame
- Detect anomalies (faces, eyes, tabs)
- Calculate risk score
- Log events
```

### Step 4: End Exam
```
POST /exam/end
→ Stop monitoring
```

### Step 5: Generate Report
```
POST /generate-report
→ Complete audit log with evidence
→ Risk assessment and flags
```

---

## 🛠️ How to Extend

### Add Advanced Face Recognition:
Edit `ai-services/pre_exam_verification.py` and replace OpenCV with:
- DeepFace
- FaceNet
- ArcFace

### Add Eye-Gaze Tracking:
Edit `ai-services/live_monitoring.py` and add:
- MediaPipe Face Mesh
- PyGaze

### Add Speech Detection:
Edit `ai-services/live_monitoring.py` and add:
- OpenAI Whisper
- Google Cloud Speech-to-Text

### Add Database Persistence:
Uncomment MongoDB integration in `backend/index.js`:
```javascript
import mongoose from 'mongoose';
// Configure MongoDB connection
```

---

## 🌐 Frontend (Optional)

To add a React frontend:
```bash
cd frontend
npm install
npm start
# Runs on http://localhost:3000
```

The frontend can integrate with all backend APIs for:
- Candidate exam interface
- Institution dashboard
- Real-time monitoring display

---

## 📊 Architecture Highlights

```
┌─────────────────────────────────────────┐
│  Candidate Browser / Mobile App         │
│  (Optional React Frontend)              │
└────────────────┬────────────────────────┘
                 │ (HTTP/REST)
┌────────────────▼────────────────────────┐
│   Backend API (Node.js/Express)         │
│   - Session orchestration               │
│   - Event routing & logging             │
│   - Report generation                   │
└────┬────────┬────────┬──────────┬───────┘
     │        │        │          │
     ▼        ▼        ▼          ▼
  ┌──────┐ ┌──────┐ ┌──────┐  ┌──────┐
  │Pre-  │ │Live  │ │Intel │ │Post- │
  │Exam  │ │Mon   │ │Flag  │ │Audit │
  │Ver   │ │itor  │ │ging  │ │     │
  │(8000)│ │(8001)│ │(8002)│ │(8003)│
  └──────┘ └──────┘ └──────┘  └──────┘
     │        │        │          │
     └────────┴────────┴──────────┘
      (Python/Flask Microservices)
             │
             ▼
      [MongoDB - Optional]
```

---

## 🔒 Security Considerations

✅ **Privacy:** Face data processed locally, not stored
✅ **Fairness:** Weighted scoring prevents false positives (e.g., sneezes flagged as violations)
✅ **Transparency:** Complete evidence log for all decisions
✅ **Scalability:** Microservices architecture allows independent scaling
✅ **Auditability:** Timestamped reports for compliance

---

## 📞 Troubleshooting

### Service Won't Start?
```bash
# Check if port is in use
netstat -ano | findstr :8000  # Windows
lsof -i :8000                 # Mac/Linux
# Kill the process and restart
```

### Python Module Errors?
```bash
# Reinstall dependencies in virtual environment
.venv/Scripts/activate  # or source .venv/bin/activate on Mac/Linux
pip install -r requirements.txt
```

### Backend Connection Issues?
```bash
# Backend doesn't require MongoDB for development
# If you want to enable it, start MongoDB and update index.js
```

---

## 🎉 What's Next?

1. **Test the API** - Use the curl examples above
2. **Build the Frontend** - Implement React UI in `frontend/`
3. **Deploy Services** - Use Docker for containerization
4. **Add ML Models** - Integrate advanced AI for higher accuracy
5. **Scale Up** - Use Kubernetes for production deployment

---

## 📚 Documentation Files

- **README.md** - Project overview
- **API_DOCUMENTATION.md** - Detailed endpoint reference
- **QUICKSTART.md** - This file
- **[Service-specific README](./ai-services/)** - Individual service docs

---

## 🎓 Educational Value

This platform demonstrates:
- **Microservices Architecture** - Independent, scalable services
- **AI/ML Integration** - Computer vision and risk scoring
- **REST API Design** - Proper HTTP endpoint structure
- **Real-time Processing** - Live monitoring and event handling
- **Privacy by Design** - Minimal data exposure while maximizing security

---

**Status: ✅ All Services Running**
**Last Updated: 2026-02-21**
**Platform Ready for: Development, Testing, Integration**
