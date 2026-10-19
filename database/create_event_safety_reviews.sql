-- Migration: Create event_safety_reviews audit log table
-- Preserves the decision history, officer notes, and reasons across safety checks.

CREATE TABLE IF NOT EXISTS public.event_safety_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    safety_officer_id UUID NOT NULL REFERENCES public.profiles(id),
    decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED')),
    notes TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT safety_reviews_reason_required_for_non_approval
        CHECK (
            decision = 'APPROVED'
            OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
        )
);

CREATE INDEX IF NOT EXISTS event_safety_reviews_event_id_idx
    ON public.event_safety_reviews (event_id, created_at DESC);

-- Enable Row Level Security
ALTER TABLE public.event_safety_reviews ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.event_safety_reviews TO authenticated;

-- Policies for viewing and inserting safety reviews
CREATE POLICY "Safety Officers and Coordinators can view safety reviews"
    ON public.event_safety_reviews
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'safety_officer'
        )
        OR EXISTS (
            SELECT 1 FROM public.events
            WHERE events.id = event_safety_reviews.event_id
              AND (events.coordinator_id = (SELECT auth.uid()) OR events.organiser_id = (SELECT auth.uid()))
        )
    );

CREATE POLICY "Safety Officers can insert safety reviews"
    ON public.event_safety_reviews
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'safety_officer'
        )
        AND safety_officer_id = (SELECT auth.uid())
    );