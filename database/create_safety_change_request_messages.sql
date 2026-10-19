-- Migration: Create safety_change_request_messages table
-- Stores discussion messages between Safety Officers and Event Coordinators during safety reviews.

CREATE TABLE IF NOT EXISTS public.safety_change_request_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.profiles(id),
    message TEXT NOT NULL CHECK (length(btrim(message)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS safety_change_messages_event_idx
    ON public.safety_change_request_messages (event_id, created_at ASC);

-- Enable Row Level Security
ALTER TABLE public.safety_change_request_messages ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON public.safety_change_request_messages TO authenticated;

-- RLS Policy: Only assigned Coordinator and Safety Officers can view or post messages
CREATE POLICY "Safety Officers and assigned Coordinators can access messages"
    ON public.safety_change_request_messages
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'safety_officer'
        )
        OR EXISTS (
            SELECT 1 FROM public.events
            WHERE events.id = safety_change_request_messages.event_id
              AND events.coordinator_id = (SELECT auth.uid())
        )
    )
    WITH CHECK (
        sender_id = (SELECT auth.uid())
        AND (
            EXISTS (
                SELECT 1 FROM public.profiles
                WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'safety_officer'
            )
            OR EXISTS (
                SELECT 1 FROM public.events
                WHERE events.id = safety_change_request_messages.event_id
                  AND events.coordinator_id = (SELECT auth.uid())
            )
        )
    );