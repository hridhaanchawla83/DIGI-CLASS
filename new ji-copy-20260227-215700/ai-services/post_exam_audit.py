# Post-Exam Audit & Report Service

from flask import Flask, request, jsonify
import datetime

app = Flask(__name__)

@app.route('/generate-report', methods=['POST'])
def generate_report():
    data = request.get_json()
    # Expected input: { 'candidate_id': str, 'exam_id': str, 'risk_score': float, 'flag': str, 'evidence': list }
    report = {
        'candidate_id': data.get('candidate_id'),
        'exam_id': data.get('exam_id'),
        'risk_score': data.get('risk_score'),
        'flag': data.get('flag'),
        'evidence': data.get('evidence'),
        'generated_at': datetime.datetime.utcnow().isoformat()
    }
    # TODO: Save report to database, attach media evidence if available
    return jsonify({'report': report, 'status': 'success'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8003)
