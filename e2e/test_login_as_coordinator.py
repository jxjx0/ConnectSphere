import os
import unittest

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")


class TestCoordinator(unittest.TestCase):
    """Visual navigation checks for coordinator event and request pages."""

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

    def test_coordinator_view_tabs(self):
        """Check event tabs and equipment/venue request views without changing records."""
        expect(
            self.page.get_by_role(
                "heading", name="Bring people together. Make"
            )
        ).to_be_visible()

        self.page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        self.page.get_by_role("textbox", name="Email address").fill(
            "maggiemee3103+coordinator@gmail.com"
        )
        self.page.get_by_role("textbox", name="Password").fill("password")
        self.page.get_by_role("button", name="Log in").click()

        expect(self.page.get_by_role("heading", name="My Events")).to_be_visible()
        expect(self.page.get_by_text("See what needs you next, and")).to_be_visible()

        self.page.get_by_role("tab", name="In progress (8)").click()
        self.page.get_by_role("tab", name="Closed (6)").click()
        self.page.get_by_role("link", name="Equipment requests").click()
        expect(
            self.page.get_by_role("heading", name="Equipment requests")
        ).to_be_visible()
        self.page.get_by_role("button", name="Past (4)").click()

        self.page.get_by_role("link", name="Venue requests").click()
        expect(
            self.page.get_by_role("heading", name="Venue requests")
        ).to_be_visible()
        self.page.get_by_role("link", name="Events").click()
        self.page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()