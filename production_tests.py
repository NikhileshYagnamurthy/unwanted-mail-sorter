import os
import sys
import json
import time
from unittest.mock import MagicMock, patch
from datetime import date

# Add project directory to sys.path
sys.path.append('/home/ubuntu/inbox-ai/unwanted-mail-sorter-main')

# Mock environment
os.environ['SECRET_KEY'] = 'prod-secret-key'
os.environ['JWT_SECRET'] = 'prod-jwt-secret'
os.environ['GOOGLE_CLIENT_ID'] = 'prod-client-id'
os.environ['SUPABASE_URL'] = 'http://localhost'
os.environ['SUPABASE_KEY'] = 'prod-key'

from backend_flask import app, create_backend_token, verify_backend_token

def test_jwt_authentication():
    print("Testing JWT Authentication...")
    email = "user@example.com"
    token = create_backend_token(email)
    
    # 1. Verify token content
    decoded_email = verify_backend_token(token)
    assert decoded_email == email
    print("  ✅ Token creation and verification successful.")
    
    # 2. Verify expiration
    # Create an already expired token
    import jwt
    expired_payload = {"email": email, "exp": time.time() - 100}
    expired_token = jwt.encode(expired_payload, 'prod-jwt-secret', algorithm="HS256")
    
    expired_email = verify_backend_token(expired_token)
    assert expired_email is None
    print("  ✅ Token expiration handled.")

def test_usage_tracking():
    print("\nTesting Usage Tracking & Limits...")
    email = "free@example.com"
    token = create_backend_token(email)
    
    with app.test_client() as client:
        with patch('backend_flask.get_user') as mock_get:
            with patch('backend_flask.update_user') as mock_update:
                # Mock free user at limit
                mock_get.return_value = {
                    "email": email, 
                    "is_premium": False, 
                    "scans_today": 5, 
                    "last_reset_date": str(date.today())
                }
                resp = client.post('/usage/increment-scan', headers={"Authorization": f"Bearer {token}"})
                assert resp.status_code == 429
                print("  ✅ Daily scan limit (5) enforced for free users.")
                
                # Mock premium user
                mock_get.return_value = {
                    "email": email, 
                    "is_premium": True, 
                    "scans_today": 100, 
                    "last_reset_date": str(date.today())
                }
                resp = client.post('/usage/increment-scan', headers={"Authorization": f"Bearer {token}"})
                assert resp.status_code == 200
                print("  ✅ Unlimited scans allowed for premium users.")

def test_cleanup_validation():
    print("\nTesting Cleanup Validation...")
    email = "free@example.com"
    token = create_backend_token(email)
    
    with app.test_client() as client:
        with patch('backend_flask.get_user') as mock_get:
            # Free user limit
            mock_get.return_value = {"email": email, "is_premium": False}
            resp = client.post('/usage/validate-cleanup', 
                               headers={"Authorization": f"Bearer {token}"},
                               json={"count": 60})
            assert resp.status_code == 403
            print("  ✅ Bulk cleanup limit (50) enforced for free users.")
            
            # Premium user
            mock_get.return_value = {"email": email, "is_premium": True}
            resp = client.post('/usage/validate-cleanup', 
                               headers={"Authorization": f"Bearer {token}"},
                               json={"count": 500})
            assert resp.status_code == 200
            print("  ✅ Unlimited cleanup allowed for premium users.")

if __name__ == "__main__":
    try:
        test_jwt_authentication()
        test_usage_tracking()
        test_cleanup_validation()
        print("\n🎉 ALL PRODUCTION BACKEND TESTS PASSED!")
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)
