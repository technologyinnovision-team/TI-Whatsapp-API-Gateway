import unittest
import json
import os
import sys

# Ensure flask-app path is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'flask-app')))

from app import app, db, User, WhatsappAccount, generate_api_key

class WhatsAppPlatformTestCase(unittest.TestCase):
    def setUp(self):
        app.config['TESTING'] = True
        app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:'
        app.config['WTF_CSRF_ENABLED'] = False
        self.app = app.test_client()
        with app.app_context():
            db.create_all()
            # Create a test user
            self.test_api_key = generate_api_key()
            user = User(
                username='testadmin',
                password='pbkdf2:sha256:testpassword',
                api_key=self.test_api_key,
                is_admin=True
            )
            db.session.add(user)
            db.session.commit()
            self.test_user_id = user.id

    def tearDown(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()

    def test_health_endpoint(self):
        response = self.app.get('/api/v1/system/health')
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertEqual(data.get('status'), 'healthy')
        self.assertIn('resources', data)
        self.assertIn('cpuPercent', data['resources'])

    def test_unauthorized_api_send(self):
        # Attempt send without API Key
        response = self.app.post('/api/v1/send/text', json={
            'account_id': 'marketing',
            'to': '15551234567',
            'message': 'Hello'
        })
        self.assertEqual(response.status_code, 401)

    def test_authorized_api_send_missing_params(self):
        # Authenticated with valid API key, but missing params
        response = self.app.post('/api/v1/send/text',
            headers={'X-API-Key': self.test_api_key},
            json={'account_id': 'marketing'}
        )
        self.assertEqual(response.status_code, 400)

    def test_account_creation_and_api_list(self):
        with app.app_context():
            acc = WhatsappAccount(
                user_id=self.test_user_id,
                alias='support_desk',
                session_id='test-uuid-1234',
                mode='safe'
            )
            db.session.add(acc)
            db.session.commit()

        # Query via API
        response = self.app.get('/api/v1/sessions', headers={'X-API-Key': self.test_api_key})
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertTrue(data.get('success'))
        self.assertEqual(len(data.get('sessions', [])), 1)
        self.assertEqual(data['sessions'][0]['alias'], 'support_desk')

    def test_legacy_send_compatibility_validation(self):
        # 1. Test missing params
        resp = self.app.post('/api/v1/send',
            headers={'X-API-Key': self.test_api_key},
            json={'account_id': 'fahadstyles'}
        )
        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.data)
        self.assertIn('Missing params', data.get('error', ''))

        # 2. Test account not found
        resp = self.app.post('/api/v1/send',
            headers={'X-API-Key': self.test_api_key},
            json={'account_id': 'nonexistent', 'to': '12345678', 'message': 'Hello'}
        )
        self.assertEqual(resp.status_code, 404)

        # 3. Create 'fahadstyles' account and test legacy dispatch schema
        with app.app_context():
            acc = WhatsappAccount(
                user_id=self.test_user_id,
                alias='fahadstyles',
                session_id='fahadstyles-session-uuid',
                mode='standard'
            )
            db.session.add(acc)
            db.session.commit()

        resp = self.app.post('/api/v1/send',
            headers={'X-API-Key': self.test_api_key},
            json={
                'account_id': 'fahadstyles',
                'to': '923001234567',
                'message': 'Order #4821 confirmation'
            }
        )
        # Even if bridge offline during test, verify response structure matches legacy format
        self.assertEqual(resp.status_code, 200)
        data = json.loads(resp.data)
        self.assertIn('status', data)
        self.assertIn('total', data)
        self.assertIn('successful', data)
        self.assertIn('failed', data)
        self.assertIn('details', data)
        self.assertEqual(data['total'], 1)
        self.assertEqual(len(data['details']), 1)
        self.assertEqual(data['details'][0]['to'], '923001234567')

    def test_buttons_endpoint_validation_and_dispatch(self):
        # 1. Missing fields check
        resp = self.app.post('/api/v1/send/buttons',
            headers={'X-API-Key': self.test_api_key},
            json={'account_id': 'fahadstyles'}
        )
        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.data)
        self.assertIn('Missing required fields', data.get('error', ''))

        # 2. Account not found
        resp = self.app.post('/api/v1/send/buttons',
            headers={'X-API-Key': self.test_api_key},
            json={
                'account_id': 'missing_acc',
                'to': '923001234567',
                'message': 'Hello',
                'buttons': [{'type': 'cta_url', 'text': 'Visit', 'url': 'https://fahadstyles.com'}]
            }
        )
        self.assertEqual(resp.status_code, 404)

        # 3. Create account and dispatch buttons
        with app.app_context():
            acc = WhatsappAccount(
                user_id=self.test_user_id,
                alias='fahadstyles_buttons',
                session_id='buttons-session-uuid',
                mode='standard'
            )
            db.session.add(acc)
            db.session.commit()

        resp = self.app.post('/api/v1/send/buttons',
            headers={'X-API-Key': self.test_api_key},
            json={
                'account_id': 'fahadstyles_buttons',
                'to': '923001234567',
                'title': 'Fahad Styles Flash Sale',
                'message': 'Enjoy 50% discount on all new summer arrivals!',
                'footer': 'Official Store Notification',
                'buttons': [
                    {'type': 'cta_url', 'text': 'Shop Now', 'url': 'https://fahadstyles.com/sale'},
                    {'type': 'cta_call', 'text': 'Call Helpline', 'phone': '+923001234567'},
                    {'type': 'cta_copy', 'text': 'Copy Code', 'code': 'SALE50'}
                ]
            }
        )
        # Verify call completes without 500 server crash (bridge may be offline in unit test)
        self.assertIn(resp.status_code, [200, 502])

    def test_swagger_and_openapi_docs(self):
        resp_docs = self.app.get('/docs')
        self.assertEqual(resp_docs.status_code, 200)
        resp_redoc = self.app.get('/redoc')
        self.assertEqual(resp_redoc.status_code, 200)
        resp_yaml = self.app.get('/static/openapi.yaml')
        self.assertEqual(resp_yaml.status_code, 200)

if __name__ == '__main__':
    unittest.main()
