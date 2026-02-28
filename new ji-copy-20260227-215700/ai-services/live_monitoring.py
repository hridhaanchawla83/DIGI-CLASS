from flask import Flask, request, jsonify
import cv2
import numpy as np
import base64
from io import BytesIO
from PIL import Image

app = Flask(__name__)

# Load Haar Cascade classifiers
face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
eye_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')

# Store previous frame for motion detection
previous_frame_gray = None
motion_threshold = 18  # LOWERED from 25 for more sensitivity
frame_count = 0

def base64_to_cv2(base64_string):
    """Convert base64 encoded image to OpenCV format"""
    try:
        if ',' in base64_string:
            base64_string = base64_string.split(',')[1]
        img_data = base64.b64decode(base64_string)
        img_array = np.frombuffer(img_data, dtype=np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        if img is None:
            print("[BASE64] Decode returned None")
            return None
        return img
    except Exception as e:
        print(f"[BASE64] Error decoding: {e}")
        return None

def detect_faces_in_frame(frame):
    """Detect faces using Haar Cascade - ENHANCED SENSITIVITY"""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # More sensitive parameters: lower scaleFactor (1.1 instead of 1.3) detects more faces
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(20, 20))
    return len(faces), faces, gray

def detect_eye_movement(frame, faces):
    """Detect unusual eye behavior - ENHANCED SENSITIVITY"""
    if len(faces) == 0:
        return False
    
    x, y, w, h = faces[0]
    roi = frame[y:y+h, x:x+w]
    gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    # More sensitive eye detection
    eyes = eye_cascade.detectMultiScale(gray_roi, scaleFactor=1.05, minNeighbors=3, minSize=(10, 10))
    
    # ENHANCED: Eyes count not equal to 2 is suspicious
    # 0 eyes = looking away or obscured (SUSPICIOUS)
    # 1 eye = one eye closed or head angle (SUSPICIOUS)
    # 3+ eyes = false positive but still log it
    eye_movement = len(eyes) != 2
    
    return eye_movement

def detect_motion_anomaly(gray_frame):
    """Detect unusual motion in frame - ENHANCED SENSITIVITY"""
    global previous_frame_gray
    
    if previous_frame_gray is None:
        previous_frame_gray = cv2.resize(gray_frame, (320, 240))
        return False
    
    # Compare frames
    resized = cv2.resize(gray_frame, (320, 240))
    diff = cv2.absdiff(previous_frame_gray, resized)
    motion_level = np.mean(diff)
    
    previous_frame_gray = resized
    
    # ENHANCED: More sensitive to motion (lowered threshold)
    anomaly = motion_level > motion_threshold
    
    return anomaly

@app.route('/monitor-faces', methods=['POST'])
def monitor_faces():
    try:
        data = request.json
        base64_image = data.get('frame', '')
        
        frame = base64_to_cv2(base64_image)
        if frame is None:
            return jsonify({'num_faces': 0, 'multiple_faces': False})
        
        num_faces, _, _ = detect_faces_in_frame(frame)
        return jsonify({
            'num_faces': num_faces,
            'multiple_faces': num_faces > 1
        })
    except:
        return jsonify({'num_faces': 0, 'multiple_faces': False})

@app.route('/monitor-eye', methods=['POST'])
def monitor_eye():
    try:
        data = request.json
        base64_image = data.get('frame', '')
        
        frame = base64_to_cv2(base64_image)
        if frame is None:
            return jsonify({'eye_movement_detected': False})
        
        num_faces, faces, _ = detect_faces_in_frame(frame)
        eye_movement = detect_eye_movement(frame, faces)
        
        return jsonify({'eye_movement_detected': eye_movement})
    except:
        return jsonify({'eye_movement_detected': False})

@app.route('/analyze-live', methods=['POST'])
def analyze_live():
    """Real-time live analysis - main endpoint for WebSocket"""
    global frame_count
    frame_count += 1
    
    try:
        data = request.json
        base64_image = data.get('frame', '')
        
        if not base64_image:
            print(f"[FRAME {frame_count}] No frame received")
            return jsonify({
                'multiple_faces': False,
                'eye_movement_detected': False,
                'anomaly_detected': False,
                'motion_detected': False,
                'num_faces': 0,
                'confidence': 0.0
            })
        
        # Decode frame
        frame = base64_to_cv2(base64_image)
        if frame is None:
            print(f"[FRAME {frame_count}] Frame decode FAILED - {len(base64_image)} bytes")
            return jsonify({
                'multiple_faces': False,
                'eye_movement_detected': False,
                'anomaly_detected': False,
                'motion_detected': False,
                'num_faces': 0,
                'confidence': 0.0
            })
        
        print(f"[FRAME {frame_count}] Received {len(base64_image)} bytes, shape {frame.shape}")
        
        # Resize for efficiency
        frame = cv2.resize(frame, (640, 480))
        
        # Multiple face check
        num_faces, faces, gray = detect_faces_in_frame(frame)
        multiple_faces = num_faces > 1
        
        # Eye movement check
        eye_movement = detect_eye_movement(frame, faces)
        
        # Motion anomaly check
        motion = detect_motion_anomaly(gray)
        
        # ANY anomaly = alert
        anomaly_detected = multiple_faces or eye_movement or motion
        
        # ENHANCED: Better confidence scoring
        confidence = 0.95 if num_faces == 1 and not eye_movement and not motion else 0.7
        
        result = {
            'multiple_faces': multiple_faces,
            'eye_movement_detected': eye_movement,
            'anomaly_detected': anomaly_detected,
            'motion_detected': motion,
            'num_faces': num_faces,
            'confidence': confidence,
            'frame_number': frame_count
        }
        
        # DETAILED LOGGING
        log_msg = f"[FRAME {frame_count}] Faces={num_faces} Multiple={multiple_faces} Eyes={eye_movement} Motion={motion} -> ANOMALY={anomaly_detected}"
        if anomaly_detected:
            print(f"*** ALERT *** {log_msg}")
        else:
            print(log_msg)
        
        return jsonify(result)
        
    except Exception as e:
        print(f"[FRAME {frame_count}] EXCEPTION: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'multiple_faces': False,
            'eye_movement_detected': False,
            'anomaly_detected': False,
            'motion_detected': False,
            'num_faces': 0,
            'confidence': 0.0,
            'error': str(e)
        })

@app.route('/monitor-audio', methods=['POST'])
def monitor_audio():
    return jsonify({'audio_anomaly_detected': False})

@app.route('/monitor-tab', methods=['POST'])
def monitor_tab():
    return jsonify({'tab_switch_detected': False})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'running', 'service': 'live_monitoring'})

if __name__ == '__main__':
    print("\n" + "="*60)
    print("LIVE MONITORING AI SERVICE - REAL-TIME PROCTORING")
    print("="*60)
    print("[+] Face Detection (Haar Cascade)")
    print("[+] Eye Movement Detection")
    print("[+] Motion Analysis")
    print("[+] Real-time Frame Processing")
    print("\n[*] Starting on http://localhost:8001")
    print("="*60 + "\n")
    app.run(host='127.0.0.1', port=8001, debug=False, threaded=True)
