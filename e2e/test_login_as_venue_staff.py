import os
import re
import unittest

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:5173/")
VENUE_STAFF_EMAIL = "maggiemee3103+venuestaff@gmail.com"
VENUE_STAFF_PASSWORD = "password"


class TestVenueStaff(unittest.TestCase):
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

    def test_venue_staff_workspace(self):
        page = self.page

        expect(
            page.get_by_role("heading", name="Bring people together. Make")
        ).to_be_visible()
        page.locator("#main-content").get_by_role(
            "link", name="Log in"
        ).click()
        page.get_by_role("textbox", name="Email address").fill(VENUE_STAFF_EMAIL)
        page.get_by_role("textbox", name="Password").fill(VENUE_STAFF_PASSWORD)
        page.get_by_role("button", name="Log in").click()

        expect(page.get_by_role("link", name="Overview")).to_be_visible()
        expect(
            page.get_by_role("link", name="Venue booking request", exact=True)
        ).to_be_visible()
        expect(
            page.get_by_role("link", name="Availability", exact=True)
        ).to_be_visible()

        page.get_by_role("link", name="Venue catalogue", exact=True).click()
        expect(page.get_by_role("heading", name="Venue Catalogue")).to_be_visible()
        expect(page.get_by_role("columnheader", name="Venue")).to_be_visible()
        page.get_by_role("searchbox", name="Search venues").fill("Campus Green")
        expect(
            page.get_by_role("rowheader", name="Campus Green Lounge 90")
        ).to_be_visible()

        page.get_by_role("link", name="Overview").click()
        expect(page.get_by_role("heading", name="Venue management")).to_be_visible()
        tasks = page.get_by_role("region", name="Venue management tasks")
        expect(tasks).to_contain_text("Venue booking requests")
        expect(tasks).to_contain_text("Venue calendar availability")
        expect(tasks).to_contain_text("Venue catalogue")

        page.get_by_role(
            "link", name=re.compile("Venue booking requests")
        ).click()
        expect(
            page.get_by_role("heading", name="Review Venue Requests")
        ).to_be_visible()

        page.get_by_role("link", name="Overview").click()
        page.get_by_role("link", name="Venue calendar availability").click()
        expect(
            page.get_by_role("heading", name="Venue Availability")
        ).to_be_visible()
        expect(
            page.get_by_role("complementary", name="Schedule controls")
        ).to_be_visible()
        page.get_by_role("button", name="Venue", exact=True).click()
        page.get_by_role(
            "option", name=re.compile("ACS Hall E2E 123 Main Street")
        ).click()
        schedule = page.get_by_role("region", name="Venue schedule")
        expect(schedule).to_be_visible()
        expect(
            page.get_by_role("heading", name="ACS Hall E2E", exact=True)
        ).to_be_visible()

        page.get_by_role("button", name="Block / Tentative Hold").click()
        dialog = page.get_by_role("dialog", name="Block / Tentative Hold")
        expect(dialog).to_be_visible()
        dialog.press("Escape")
        expect(dialog).not_to_be_visible()

        page.get_by_role("link", name="Overview").click()
        page.get_by_role(
            "link", name=re.compile("Venue catalogue.*View Venue")
        ).click()
        expect(page.get_by_role("heading", name="Venue Catalogue")).to_be_visible()
        expect(page.get_by_text("Search venues")).to_be_visible()
        page.get_by_role("searchbox", name="Search venues").fill("Campus Green")
        expect(
            page.get_by_role("rowheader", name="Campus Green Lounge 90")
        ).to_be_visible()

        page.get_by_role("link", name="Overview").click()
        page.get_by_role("link", name="Create venue profile").click()
        expect(
            page.get_by_role("heading", name="Create Venue Profile")
        ).to_be_visible()
        expect(
            page.get_by_role("group", name=re.compile("Basic information"))
            .locator("legend")
        ).to_be_visible()
        expect(page.get_by_text("Layouts and capacity")).to_be_visible()
        expect(page.get_by_text("Facilities and accessibility")).to_be_visible()
        expect(page.get_by_text("04 Operating hours and")).to_be_visible()
        page.get_by_role("link", name="Layouts & capacity").click()
        page.get_by_role("link", name="Back to catalogue").click()
        expect(page.get_by_role("heading", name="Venue Catalogue")).to_be_visible()

        page.get_by_role("button", name="Log out").click()


if __name__ == "__main__":
    unittest.main()
