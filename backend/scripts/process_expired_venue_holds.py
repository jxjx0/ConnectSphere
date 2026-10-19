"""Run every minute with the backend environment: python scripts/process_expired_venue_holds.py."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.venue_hold_service import process_expired_holds

if __name__ == "__main__":
    print(f"Expiry notifications saved: {process_expired_holds()}")
