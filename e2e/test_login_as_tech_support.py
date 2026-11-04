import os
import re
import unittest

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")
TECH_SUPPORT_EMAIL = "maggiemee3103+techsupport@gmail.com"
TECH_SUPPORT_PASSWORD = "password"


class TestTechSupport(unittest.TestCase):
    """Read-only visual checks for Technical Support's equipment workspace."""

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

    def test_tech_support_equipment_workspace(self):
        """Check request history, catalogue search/form, and shared-booking calendar.

        This flow only reads existing data and opens the equipment form; it
        does not review requests, edit or create equipment, or add bookings.
        """
        page = self.page

        expect(
            page.get_by_role("heading", name="Bring people together. Make")
        ).to_be_visible()
        page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        page.get_by_role("textbox", name="Email address").fill(TECH_SUPPORT_EMAIL)
        page.get_by_role("textbox", name="Password").fill(TECH_SUPPORT_PASSWORD)
        page.get_by_role("button", name="Log in").click()

        expect(page.get_by_role("link", name="Requests")).to_be_visible()
        expect(page.get_by_role("link", name="Catalogue")).to_be_visible()
        expect(page.get_by_role("link", name="Shared bookings")).to_be_visible()
        expect(
            page.get_by_role("heading", name="Review Equipment Requests")
        ).to_be_visible()
        expect(
            page.get_by_role("heading", name=re.compile(r"Pending requests \(\d+\)"))
        ).to_be_visible()
        page.get_by_role("button", name=re.compile(r"Reviewed \(\d+\)")).click()
        expect(
            page.get_by_role("heading", name=re.compile(r"Reviewed requests \(\d+\)"))
        ).to_be_visible()

        page.get_by_role("link", name="Catalogue").click()
        expect(
            page.get_by_role("heading", name="Equipment Catalogue", exact=True)
        ).to_be_visible()
        expect(
            page.get_by_role("heading", name="Equipment catalogue", exact=True)
        ).to_be_visible()
        expect(
            page.get_by_role("columnheader", name="Equipment", exact=True)
        ).to_be_visible()
        page.get_by_role("searchbox", name="Name").fill("Audio Mixer")
        expect(page.get_by_role("rowheader", name="Audio Mixer")).to_be_visible()
        page.get_by_role("searchbox", name="Name").fill("")

        page.get_by_role("link", name="Create Equipment Profile").click()
        expect(
            page.get_by_role("heading", name="Create Equipment Profile")
        ).to_be_visible()
        expect(page.get_by_role("heading", name="Equipment details")).to_be_visible()
        expect(page.get_by_label("Name")).to_be_visible()
        expect(page.get_by_label("Type")).to_be_visible()
        expect(page.get_by_label("Status")).to_be_visible()
        expect(page.get_by_role("button", name="Save equipment")).to_be_visible()
        page.get_by_role("link", name="← Back").click()
        expect(
            page.get_by_role("heading", name="Equipment Catalogue", exact=True)
        ).to_be_visible()

        page.get_by_role("link", name="Shared bookings").click()
        expect(
            page.get_by_role("heading", name="Shared Equipment Bookings")
        ).to_be_visible()
        expect(page.get_by_role("columnheader", name="Thu")).to_be_visible()
        expect(
            page.get_by_role("button", name="Previous month")
        ).to_be_visible()
        expect(page.get_by_role("button", name="Next month")).to_be_visible()

        page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()
