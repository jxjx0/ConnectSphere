import os
import unittest
# copied from labs 9
from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")


class TestSample(unittest.TestCase):
    # Setup and teardown methods for the test class
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
        self.page.close()
        self.context.close()

    # Real test flow for organizer event creation lifecycle
    def test_organizer_flow(self):
        # 1. Login
        self.page.locator("#main-content").get_by_role("link", name="Log in").click()
        self.page.get_by_role("textbox", name="Email address").fill("maggiemee3103+organiser@gmail.com")
        self.page.get_by_role("textbox", name="Password").fill("password")
        self.page.get_by_role("textbox", name="Password").press("Enter")

        # 2. Verify Authenticated Home Page State
        expect(self.page.get_by_role("link", name="My events")).to_be_visible()
        expect(self.page.get_by_role("link", name="New event")).to_be_visible()
        expect(self.page.get_by_role("link", name="ConnectSphere home")).to_be_visible()
        expect(self.page.locator("h1")).to_contain_text("My Events")
        expect(self.page.get_by_role("paragraph")).to_contain_text(
            "See what needs you next, follow your requests, or continue a saved draft."
        )

        # 3. Navigate to Event Request Page
        self.page.get_by_role("link", name="New event").click()
        expect(self.page.locator("h1")).to_contain_text("Request an event")
        expect(self.page.locator("form")).to_contain_text("Event details")
        expect(self.page.get_by_role("heading", name="Event details")).to_be_visible()
        expect(self.page.locator("form")).to_be_visible()

        # 4. Return to My Events & Logout
        self.page.get_by_role("link", name="My events").click()
        expect(self.page.get_by_role("button", name="Log out")).to_be_visible()
        self.page.get_by_role("button", name="Log out").click()

        # 5. Verify Unauthenticated Landing State
        expect(self.page.get_by_role("heading", name="Bring people together. Make")).to_be_visible()
        expect(self.page.get_by_text("Already registered? Log in")).to_be_visible()


if __name__ == "__main__":
    unittest.main()