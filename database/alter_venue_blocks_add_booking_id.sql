-- Migration: Add booking_id foreign key link to venue_blocks
-- Allows direct tracking and cascading cleanup of operational calendar locks.

ALTER TABLE public.venue_blocks
    ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES public.venue_bookings(booking_id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS venue_blocks_booking_id_idx
    ON public.venue_blocks(booking_id);