-- ConnectSphere VENUE_BLOCKS entity.
-- Stores periods during which a venue is unavailable.
--
-- A venue block records:
--   - the venue being blocked
--   - the reason for the block
--   - the start and end of the unavailable period
--   - the authenticated profile that created the block
--
-- Block-to-block overlap is intentionally not restricted by this schema.
-- Booking conflict rules are not implemented here because the booking
-- system does not yet exist.

create table public.venue_blocks (
    block_id uuid primary key default gen_random_uuid(),
    venue_id uuid not null
        references public.venues(id),
    block_reason text not null,
    start_at timestamptz not null,
    end_at timestamptz not null,
    block_issuer uuid not null
        references public.profiles(id),

    constraint venue_blocks_reason_not_blank
        check (length(btrim(block_reason)) > 0),

    constraint venue_blocks_valid_period
        check (end_at > start_at)
);

-- Row Level Security
-- Venue blocks are accessible only to authenticated users.
-- Only venue staff can create blocks, and the block issuer must
-- match the currently authenticated user.

alter table public.venue_blocks enable row level security;

grant select on public.venue_blocks to authenticated;
grant insert on public.venue_blocks to authenticated;

create policy "Authenticated users can view venue blocks"
    on public.venue_blocks
    for select
    to authenticated
    using (true);

create policy "Venue staff can create venue blocks"
    on public.venue_blocks
    for insert
    to authenticated
    with check (
        public.is_venue_staff()
        and block_issuer = (select auth.uid())
    );

