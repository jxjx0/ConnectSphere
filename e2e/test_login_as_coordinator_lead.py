import os
import unittest

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")
LEAD_EMAIL = "maggiemee3103+coordinatorlead@gmail.com"
LEAD_PASSWORD = "password"


class TestCoordinatorLead(unittest.TestCase):
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
        page = self.page

        expect(
            page.get_by_role("heading", name="Bring people together. Make")
        ).to_be_visible()
        page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        page.get_by_role("textbox", name="Email address").fill(LEAD_EMAIL)
        page.get_by_role("textbox", name="Password").fill(LEAD_PASSWORD)
        page.get_by_role("button", name="Log in").click()

        expect(page.get_by_role("link", name="Unassigned events")).to_be_visible()
        expect(page.get_by_role("link", name="All events")).to_be_visible()
        expect(
            page.get_by_role("heading", name="Unassigned Events")
        ).to_be_visible()

        page.get_by_role("link", name="All events").click()
        expect(page.get_by_role("heading", name="All Events")).to_be_visible()

        page.get_by_role("searchbox", name="Event").fill("odoo")
        event_row = page.get_by_role("row").filter(
            has=page.get_by_role("rowheader", name="odoo", exact=True)
        )
        expect(event_row).to_be_visible()
        expect(page.get_by_label("Coordinator", exact=True)).to_be_visible()
        page.get_by_role("searchbox", name="Event").fill("")

        event_row = page.get_by_role("row").filter(
            has=page.get_by_role("rowheader", name="odoo", exact=True)
        )
        event_row.get_by_role("button", name="View details").click()

        dialog = page.get_by_role("dialog", name="odoo")
        expect(dialog).to_be_visible()
        dialog.get_by_role("button", name="Reassign").click()
        expect(dialog.get_by_label("New coordinator")).to_be_visible()
        expect(dialog.get_by_role("textbox", name="Reason")).to_be_visible()
        expect(
            dialog.get_by_role("button", name="Confirm reassignment")
        ).to_be_visible()
        dialog.press("Escape")
        expect(dialog).not_to_be_visible()

        page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()
