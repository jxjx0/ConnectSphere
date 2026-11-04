import os
import unittest

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")

class TestSample(unittest.TestCase):
    """Visual smoke test for attendee login and the attendee events landing page."""

    #Setup and teardown methods for the test class
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

    def test_login_attendee(self):
        """Verify attendee authentication and the events landing-page heading.

        This checks rendered navigation only; it does not register for an event.
        """
        self.page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        self.page.get_by_role("textbox", name="Email address").fill(
            "maggiemee3103+attendee@gmail.com"
        )
        self.page.get_by_role("textbox", name="Password").fill("password")
        self.page.get_by_role("textbox", name="Password").press("Enter")
        expect(
            self.page.get_by_role("heading", name="Sign up for Events here!")
        ).to_be_visible()

if __name__ == "__main__":
    unittest.main()