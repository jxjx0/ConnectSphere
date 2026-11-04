import os
import unittest

from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=20000)

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")
LEAD_EMAIL = "maggiemee3103+coordinatorlead@gmail.com"
LEAD_PASSWORD = "password"


class TestCoordinatorLead(unittest.TestCase):
    """Read-only visual checks for coordinator-lead event list pages."""

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
        self.page.set_default_timeout(20000)
        self.page.goto(BASE_URL)

    def tearDown(self):
        self.context.close()

    def test_coordinator_lead_event_overview(self):
        """Check unassigned and all-events page visuals without changing records."""
        page = self.page

        expect(
            page.get_by_role("heading", name="Bring people together. Make")
        ).to_be_visible()
        page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        page.get_by_role("textbox", name="Email address").fill(LEAD_EMAIL)
        page.get_by_role("textbox", name="Password").fill(LEAD_PASSWORD)
        page.get_by_role("textbox", name="Password").press("Enter")

        expect(
            page.get_by_role("heading", name="Unassigned Events")
        ).to_be_visible()
        expect(page.get_by_role("link", name="All events")).to_be_visible()
        expect(page.get_by_text("Loading unassigned events…")).to_be_hidden()

        page.get_by_role("link", name="All events").click()
        expect(page.get_by_role("heading", name="All Events")).to_be_visible()
        expect(page.get_by_text("Loading events…")).to_be_hidden()

        page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()
