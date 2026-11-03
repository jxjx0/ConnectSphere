import json
import os
import re
import unittest

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/").rstrip("/") + "/"
ATTENDEE_PROFILE = {
    "id": "test-attendee",
    "full_name": "Test Attendee",
    "email": "attendee@example.com",
    "role": "attendee",
}


class TestAttendeeFlows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.page = self.context.new_page()
        self.page.goto(BASE_URL)

    def tearDown(self):
        self.context.close()

    def open_attendee_signup(self):
        self.page.get_by_role("link", name=re.compile("I'm here to attend")).click()
        expect(self.page.get_by_label("Full name")).to_be_visible()
        expect(self.page.get_by_label("Contact number")).to_be_visible()

    def mock_attendee_login(self):
        self.page.route(
            "**/login",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "access_token": "test-access-token",
                    "profile": ATTENDEE_PROFILE,
                }),
            ),
        )
        self.page.route(
            "**/attendee/events",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"events": []}),
            ),
        )

    def test_attendee_signup_navigation_and_password_visibility(self):
        self.open_attendee_signup()
        expect(self.page.get_by_role("heading", name="Create an attendee account")).to_be_visible()

        password = self.page.get_by_role("textbox", name="Password")
        expect(password).to_have_attribute("type", "password")
        self.page.get_by_role("button", name="Show password").click()
        expect(password).to_have_attribute("type", "text")
        self.page.get_by_role("button", name="Hide password").click()
        expect(password).to_have_attribute("type", "password")

    def test_attendee_signup_shows_field_errors_without_submitting(self):
        signup_requests = []
        self.page.on(
            "request",
            lambda request: signup_requests.append(request)
            if request.url.endswith("/signup")
            else None,
        )
        self.open_attendee_signup()
        self.page.get_by_label("Full name").fill("Test Attendee")
        self.page.get_by_label("Email address").fill("not-an-email")
        self.page.get_by_role("textbox", name="Password").fill("short")
        self.page.get_by_role("button", name="Create account").click()

        expect(self.page.get_by_text("Enter a valid email address.")).to_be_visible()
        expect(self.page.get_by_text("Use between 8 and 72 characters.")).to_be_visible()
        self.assertEqual(signup_requests, [])

    def test_login_requires_email_and_password(self):
        self.page.get_by_role("link", name="Log in").first.click()
        self.page.get_by_role("button", name="Log in").click()

        expect(self.page.get_by_text("Enter your email address.")).to_be_visible()
        expect(self.page.get_by_text("Enter your password.")).to_be_visible()
        expect(self.page).to_have_url(re.compile(r"/login$"))

    def test_login_displays_invalid_credentials_error(self):
        self.page.route(
            "**/login",
            lambda route: route.fulfill(
                status=401,
                content_type="application/json",
                body=json.dumps({"error": "Invalid email or password"}),
            ),
        )
        self.page.get_by_role("link", name="Log in").first.click()
        self.page.get_by_label("Email address").fill("attendee@example.com")
        self.page.get_by_role("textbox", name="Password").fill("incorrect-password")
        self.page.get_by_role("button", name="Log in").click()

        expect(self.page.get_by_role("alert")).to_have_text("Invalid email or password")
        expect(self.page).to_have_url(re.compile(r"/login$"))

    def test_attendee_login_opens_events_page(self):
        self.mock_attendee_login()
        self.page.get_by_role("link", name="Log in").first.click()
        self.page.get_by_label("Email address").fill("attendee@example.com")
        self.page.get_by_role("textbox", name="Password").fill("correct-password")
        self.page.get_by_role("button", name="Log in").click()

        expect(self.page).to_have_url(re.compile(r"/attendee/events$"))
        expect(
            self.page.get_by_role("heading", name="Sign up for Events here!")
        ).to_be_visible()
        expect(self.page.get_by_text("No events are open to attendees yet.")).to_be_visible()
        self.assertEqual(
            self.page.evaluate("localStorage.getItem('connectsphere.token')"),
            "test-access-token",
        )

    def test_protected_attendee_page_redirects_to_login(self):
        self.page.goto(f"{BASE_URL}attendee/events")

        expect(self.page).to_have_url(re.compile(r"/login$"))
        expect(self.page.get_by_role("button", name="Log in")).to_be_visible()


if __name__ == "__main__":
    unittest.main()
