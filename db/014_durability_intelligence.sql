BEGIN;

CREATE TABLE IF NOT EXISTS contract_asset_assignments (
  assignment_id BIGSERIAL PRIMARY KEY,
  contract_id INT NOT NULL REFERENCES municipal_contracts(contract_id) ON DELETE CASCADE,
  segment_id INT REFERENCES contract_segments(segment_id) ON DELETE SET NULL,
  pole_id INT NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
  installed_at TIMESTAMPTZ,
  warranty_start TIMESTAMPTZ NOT NULL,
  warranty_end TIMESTAMPTZ,
  assignment_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (assignment_status IN ('PLANNED','ACTIVE','COMPLETED','CANCELLED')),
  source_reference VARCHAR(500),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contract_id, pole_id, warranty_start),
  CHECK (warranty_end IS NULL OR warranty_end >= warranty_start),
  CHECK (installed_at IS NULL OR installed_at <= warranty_start)
);

CREATE INDEX IF NOT EXISTS idx_caa_pole_warranty
  ON contract_asset_assignments(pole_id, warranty_start DESC, warranty_end DESC);
CREATE INDEX IF NOT EXISTS idx_caa_contract_status
  ON contract_asset_assignments(contract_id, assignment_status);
CREATE INDEX IF NOT EXISTS idx_caa_segment
  ON contract_asset_assignments(segment_id);
CREATE INDEX IF NOT EXISTS idx_caa_warranty_end
  ON contract_asset_assignments(warranty_end);

CREATE OR REPLACE FUNCTION set_contract_asset_assignment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_caa_updated_at ON contract_asset_assignments;
CREATE TRIGGER trg_caa_updated_at
BEFORE UPDATE ON contract_asset_assignments
FOR EACH ROW EXECUTE FUNCTION set_contract_asset_assignment_updated_at();

COMMIT;
