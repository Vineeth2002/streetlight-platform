-- 016_knowledge_policy_intelligence.sql
-- Governance layer for municipal rules, SOPs, specifications and policy records.
-- History is append-only; current knowledge item remains the read model.

ALTER TABLE municipal_knowledge_items
  ADD CONSTRAINT chk_knowledge_effective_dates
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);

CREATE INDEX IF NOT EXISTS idx_knowledge_effective_window
  ON municipal_knowledge_items(status, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS knowledge_item_events (
    event_id                BIGSERIAL PRIMARY KEY,
    knowledge_id            BIGINT NOT NULL REFERENCES municipal_knowledge_items(knowledge_id) ON DELETE CASCADE,
    action                  VARCHAR(20) NOT NULL
                            CHECK (action IN ('CREATED','UPDATED','ARCHIVED','RESTORED')),
    changed_by              INT REFERENCES users(user_id) ON DELETE SET NULL,
    changed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    before_state            JSONB,
    after_state             JSONB,
    notes                   TEXT,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_knowledge_events_item_time
  ON knowledge_item_events(knowledge_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_events_actor_time
  ON knowledge_item_events(changed_by, changed_at DESC);

CREATE OR REPLACE FUNCTION touch_knowledge_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_updated_at ON municipal_knowledge_items;
CREATE TRIGGER trg_knowledge_updated_at
BEFORE UPDATE ON municipal_knowledge_items
FOR EACH ROW EXECUTE FUNCTION touch_knowledge_updated_at();
