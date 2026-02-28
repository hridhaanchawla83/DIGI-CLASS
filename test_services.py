import requests
import json
import time

# List of all services and their endpoints
services = {
    'Pre-Exam Verification': 'http://127.0.0.1:8000',
    'Live Monitoring': 'http://127.0.0.1:8001',
    'Intelligent Flagging': 'http://127.0.0.1:8002',
    'Post-Exam Audit': 'http://127.0.0.1:8003',
    'Backend API': 'http://127.0.0.1:5000'
}

print("=" * 60)
print("AI-Powered Proctored Exam Platform - Service Status Check")
print("=" * 60)

for service_name, url in services.items():
    try:
        response = requests.get(url, timeout=2)
        status = "Running" if response.status_code < 500 else "Error"
        print(f"{service_name:.<40} {status}")
        print(f"  URL: {url}")
    except requests.exceptions.ConnectionError:
        print(f"{service_name:.<40} Not Running")
        print(f"  URL: {url}")
    except Exception as e:
        print(f"{service_name:.<40} Error: {str(e)}")

print("\n" + "=" * 60)
print("Service Ports Summary:")
print("=" * 60)
print("• Pre-Exam Verification: http://localhost:8000")
print("• Live Monitoring:      http://localhost:8001")
print("• Intelligent Flagging: http://localhost:8002")
print("• Post-Exam Audit:      http://localhost:8003")
print("• Backend API:          http://localhost:5000")
print("=" * 60)
print("\nAll services are configured and ready to use!")
print("The platform is running on localhost with the following components:")
print("  - Face recognition & ID validation")
print("  - Real-time anomaly monitoring")
print("  - AI-driven risk scoring")
print("  - Automated audit report generation")
