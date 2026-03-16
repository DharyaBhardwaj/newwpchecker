-- Add owner column to track who uploaded the numbers
ALTER TABLE public.number_dispenser ADD COLUMN IF NOT EXISTS uploaded_by BIGINT;

-- Create index for user-specific lookups
CREATE INDEX IF NOT EXISTS idx_number_dispenser_user ON public.number_dispenser(uploaded_by, is_assigned);