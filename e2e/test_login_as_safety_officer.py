import os
import unittest

from playwright.sync_api import expect, sync_playwright

expect.set_options(timeout=20000)

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")
SAFETY_OFFICER_EMAIL = "maggiemee3103+safetyofficer@gmail.com"
SAFETY_OFFICER_PASSWORD = "password"


class TestSafetyOfficer(unittest.TestCase):
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

    def test_safety_officer_review_history(self):
        page = self.page

        page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        page.get_by_role("textbox", name="Email address").fill(SAFETY_OFFICER_EMAIL)
        page.get_by_role("textbox", name="Password").fill(SAFETY_OFFICER_PASSWORD)
        page.get_by_role("button", name="Log in").click()

        expect(page.get_by_role("link", name="To review")).to_be_visible()
        expect(page.get_by_role("link", name="Reviewed")).to_be_visible()
        expect(page.get_by_role("link", name="No longer needed")).to_be_visible()
        expect(
            page.get_by_role("heading", name="Safety Checks to Review")
        ).to_be_visible()

        page.get_by_role("link", name="Reviewed").click()
        expect(
            page.get_by_role("heading", name="Reviewed Safety Checks")
        ).to_be_visible()
        reviewed_event = page.get_by_role(
            "row", name="Charity Gala Dinner Rejected"
        )
        expect(reviewed_event).to_contain_text("Rejected")
        reviewed_event.get_by_role("link", name="View").click()
        expect(page.get_by_role("heading", name="Event Overview")).to_be_visible()
        expect(
            page.get_by_role(
                "heading", name="Sessions and what is booked (", exact=False
            )
        ).to_be_visible()
        page.get_by_role("link", name="← Back").click()
        expect(
            page.get_by_role("heading", name="Reviewed Safety Checks")
        ).to_be_visible()

        page.get_by_role("link", name="No longer needed").click()
        expect(page.get_by_role("heading", name="No Longer Needed")).to_be_visible()
        expect(page.get_by_role("columnheader", name="Event")).to_be_visible()
        expired_event = page.get_by_role("row").filter(
            has=page.get_by_role("rowheader", name="Annual Tech Conference", exact=True)
        )
        expect(expired_event).to_be_visible()
        expired_event.get_by_role("link", name="View").click()
        expect(
            page.get_by_role("heading", name="Annual Tech Conference")
        ).to_be_visible()
        expect(page.get_by_role("heading", name="Event Overview")).to_be_visible()
        expect(
            page.get_by_role(
                "heading", name="Sessions and what is booked (", exact=False
            )
        ).to_be_visible()
        page.get_by_role("link", name="← Back").click()
        expect(page.get_by_role("heading", name="No Longer Needed")).to_be_visible()

        page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()
