# 🎥 LIVE PROCTORING SYSTEM - QUICK START

## ✅ SYSTEM STATUS: ALL SERVICES RUNNING

### Currently Active Services:
- **Backend API + WebSocket**: http://localhost:5000 (Port 5000)
- **Live Monitoring AI** (Face/Eye Detection): http://localhost:8001 (Port 8001)  
- **React Frontend**: http://localhost:3001 (Port 3001)
- **Real-time Alerts**: ✓ Enabled via WebSocket

---

## 🚀 WORKFLOW: Complete End-to-End Demo

### **Step 1: Student Pre-Exam**
1. Open **http://localhost:3001**
2. Keep **"👤 Student"** role selected
3. Go to **"Pre-Exam"** tab
4. Fill in:
   - Candidate ID: `STU001`
   - Exam ID: `EXAM123`
5. Click **"Start Exam Session"**
6. Wait for confirmation: ✅ Exam Session Ready!

### **Step 2: Student Takes Live Exam** 
1. Go to **"Live Exam"** tab
2. Click **"🎥 Start Webcam & Exam"**
3. **ALLOW CAMERA & MICROPHONE** when browser prompts
4. Watch the real-time monitoring panel:
   - ✓ Multiple Faces detection
   - ✓ Eye Movement tracking
   - ✓ Anomaly detection
   - ✓ Risk Score (0-100%)

**System will automatically:**
- Capture frames every 500ms
- Send to AI services for analysis
- Score risk immediately
- **Alert student & teacher if anomaly detected**

### **Step 3: Teacher Monitoring (Parallel)**
1. Open **NEW BROWSER TAB**: http://localhost:3001
2. Change role dropdown to **"👨‍🏫 Teacher Monitor"**
3. Go to **"Monitor Students"** tab
4. Watch real-time alerts as they come in:
   - 🚨 **CRITICAL**: Multiple faces detected
   - ⚠️ **WARNING**: Eye movement anomaly
   - Timestamp, Risk Score, Student Name

### **Step 4: View Exam Report**
1. Student goes to **"Reports"** tab
2. Click **"Get Report"**
3. See complete proctoring data:
   - Total frames analyzed
   - Warnings raised
   - Risk score history
   - All flagged anomalies

---

## 🔴 IMMEDIATE ALERTS & WARNINGS

### What Triggers an Alert?
1. **Multiple Faces Detected** (🚨 CRITICAL)
   - Anyone else in frame = instant alert
   - Risk Score: > 0.7 (70%)

2. **Unusual Eye Movement** (⚠️ WARNING)
   - Eyes not detected or looking away
   - Risk Score: > 0.4 (40%)

3. **Suspicious Motion** (⚠️ WARNING)  
   - Rapid head movement or unusual behavior
   - Risk Score: > 0.4 (40%)

### Alert Flow:
```
AI detects anomaly → Risk scored → Student gets INSTANT warning
                             ↓
                    Teacher gets notification
                             ↓
                    Recorded in session report
```

---

## 📊 REAL-TIME AI ANALYSIS

### Live Monitoring Service (Port 8001):
- **Face Detection**: Haar Cascade (OpenCV)
- **Eye Movement**: Detects looking away
- **Motion Analysis**: Frame-to-frame comparison
- **Processing Speed**: ~2 frames/second
- **Response Time**: < 500ms per frame

### Risk Scoring Algorithm:
```
Risk = (multipleFaces × 0.4) + (eyeMovement × 0.2) + (anomaly × 0.2) + ...
Range: 0.0 (safe) to 1.0 (high-risk)
```

---

## 🧪 TEST SCENARIOS

### Test 1: Multiple Faces Alert
1. Student starts exam
2. Have someone else enter the camera frame
3. **INSTANT**: Red warning appear on student screen
4. **INSTANT**: Teacher sees alert with student name + "Multiple Faces"
5. ✅ Works!

### Test 2: Eye Movement Alert
1. While exam running, student looks away from screen
2. **AI detects**: Eyes not visible
3. **INSTANT**: Warning "Unusual Eye Movement"
4. Teacher sees alert
5. ✅ Works!

### Test 3: Report Generation
1. Complete exam (click End Exam button)
2. Go to Reports tab
3. Click "Get Report"
4. See all frames analyzed, warnings raised, risk history
5. ✅ Works!

---

## 🎯 TECHNICAL ARCHITECTURE

```
┌─────────────────────────────────────────────────────────┐
│                   React Frontend (3001)                  │
│  - Webcam capture via getUserMedia API                  │
│  - WebSocket client socket.io connection                │
│  - Real-time UI updates                                 │
└────────────────────┬────────────────────────────────────┘
                     │ WebSocket
                     ↓
┌─────────────────────────────────────────────────────────┐
│            Node.js Backend (5000)                        │
│  - Express API server                                   │
│  - Socket.io WebSocket server                           │
│  - Session management                                   │
│  - Frame routing to AI services                         │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP REST
                     ↓
        ┌────────────┴─────────────┐
        ↓                          ↓
┌──────────────────┐    ┌──────────────────┐
│  Live Monitoring │    │  Risk Scoring    │
│   Port 8001      │    │   Port 8002      │
│   (Face + Eyes)  │    │  (Weighted Risk) │
└──────────────────┘    └──────────────────┘
```

---

## 📝 KEY FEATURES IN THIS VERSION

✅ **Live Webcam Capture**
- Real-time video from student camera
- 640x480 resolution
- 2 FPS processing (every 500ms)

✅ **Instant AI Analysis**
- Face detection via Haar Cascade
- Eye movement tracking
- Motion anomaly detection
- Weighted risk scoring

✅ **Real-Time Alerts**
- Student gets instant warning ⛔
- Teacher monitoring dashboard updated
- Alert contains risk score & reason

✅ **Dual Role Support**
- Student interface: Pre-Exam → Live Exam → Reports
- Teacher interface: Real-time monitoring + alert log

✅ **Complete Session Record**
- All frames analyzed counted
- Every warning logged with timestamp
- Full audit trail in report

---

## ⚙️ CONFIGURATION

### AI Service Ports:
- Pre-Exam (8000) - Verification
- Live Monitoring (8001) - Face/Eye detection ← **MAIN**
- Risk Scoring (8002) - Grade anomalies  
- Audit (8003) - Report generation

### Frame Processing:
- Interval: 500ms (2 FPS)
- Resolution: 640x480
- Format: Base64 JPEG
- Timeout: 3 seconds per frame

### Alert Thresholds:
- HIGH RISK: Risk Score ≥ 0.7
- MEDIUM RISK: Risk Score ≥ 0.4
- LOW RISK: Risk Score < 0.4

---

## 🎓 NEXT STEPS

### For Testing:
1. Students: Try all scenarios (face in frame, look away, etc.)
2. Teachers: Monitor in parallel window
3. Check reports for complete analysis

### Future Enhancements:
- Real HD video recording
- Advanced ML models (DeepFace, MediaPipe)
- Audio anomaly detection
- Screen recording
- Institution dashboard
- Multiple exam formats

---

## 🆘 TROUBLESHOOTING

### Camera Not Working?
- Check browser permissions for camera
- Ensure good lighting
- Try reloading page

### No Alerts Appearing?
- Verify WebSocket connected ✓
- Check Console (F12) for errors
- Ensure AI service is running (port 8001)

### Slow Processing?
- Reduce frame rate
- Check system CPU usage
- AI service might be busy

---

**Status**: ✅ FULLY OPERATIONAL  
**Last Updated**: Now  
**All Services**: Running  
**Ready for**: Real-time Proctoring
