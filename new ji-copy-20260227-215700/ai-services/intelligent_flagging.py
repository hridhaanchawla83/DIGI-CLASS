# Intelligent Flagging & Risk Scoring Service

from flask import Flask, request, jsonify
import datetime

app = Flask(__name__)

# Example weights for each anomaly type
ANOMALY_WEIGHTS = {
    'multiple_faces': 0.4,
    'eye_movement': 0.2,
    'audio_anomaly': 0.2,
    'tab_switch': 0.2
}

@app.route('/risk-score', methods=['POST'])
def risk_score():
    data = request.get_json()
    # Expected input: { 'multiple_faces': bool, 'eye_movement': bool, 'audio_anomaly': bool, 'tab_switch': bool }
    score = 0.0
    evidence = []
    for anomaly, weight in ANOMALY_WEIGHTS.items():
        if data.get(anomaly):
            score += weight
            evidence.append({
                'anomaly': anomaly,
                'timestamp': datetime.datetime.utcnow().isoformat()
            })
    # Cap score at 1.0
    score = min(score, 1.0)
    # Distinguish genuine violations from false positives
    if score >= 0.7:
        flag = 'high-risk'
    elif score >= 0.4:
        flag = 'medium-risk'
    else:
        flag = 'low-risk'
    return jsonify({
        'risk_score': score,
        'flag': flag,
        'evidence': evidence
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8002)
