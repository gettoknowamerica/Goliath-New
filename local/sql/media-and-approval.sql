-- Goliath Omni — MySQL is the system of record (Hostinger). Supabase is not on
-- the operating path. Run against the LeadForge database.

CREATE TABLE IF NOT EXISTS media_jobs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_path     VARCHAR(512) NOT NULL,
  source_name     VARCHAR(255) NOT NULL,
  slug            VARCHAR(255) NOT NULL,
  duration_sec    DECIMAL(10,2) NULL,
  width           INT NULL,
  height          INT NULL,
  status          ENUM('queued','transcribing','selecting','rendering','writing',
                       'ready_for_approval','approved','published','failed')
                  NOT NULL DEFAULT 'queued',
  episode_path    VARCHAR(512) NULL,
  transcript_path VARCHAR(512) NULL,
  error           TEXT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_slug (slug),
  KEY ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS media_clips (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_id       BIGINT NOT NULL,
  idx          INT NOT NULL,
  start_sec    DECIMAL(10,2) NOT NULL,
  end_sec      DECIMAL(10,2) NOT NULL,
  tier         CHAR(1) NOT NULL DEFAULT 'C',
  hook         VARCHAR(255) NULL,
  why          TEXT NULL,
  file_path    VARCHAR(512) NULL,
  post_status  ENUM('draft','pending_owner_approval','approved','posted','rejected')
               NOT NULL DEFAULT 'pending_owner_approval',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_job (job_id),
  CONSTRAINT fk_clip_job FOREIGN KEY (job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS blog_posts (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_id           BIGINT NULL,
  slug             VARCHAR(255) NOT NULL,
  headline         VARCHAR(255) NOT NULL,
  dek              VARCHAR(512) NULL,
  body_html        MEDIUMTEXT NOT NULL,
  meta_description VARCHAR(320) NULL,
  video_embed      VARCHAR(512) NULL,
  hero_image       VARCHAR(512) NULL,
  status           ENUM('draft','pending_owner_approval','approved','published')
                   NOT NULL DEFAULT 'pending_owner_approval',
  approved_by      VARCHAR(255) NULL,
  published_at     DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_blog_slug (slug),
  KEY ix_blog_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backs the hard-coded approval gate. No send is possible without a row here
-- in 'approved' state whose body_hash matches the text being sent.
CREATE TABLE IF NOT EXISTS email_drafts (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  recipient         VARCHAR(320) NOT NULL,
  subject           VARCHAR(512) NOT NULL,
  body              MEDIUMTEXT NOT NULL,
  body_hash         CHAR(64) NOT NULL,
  agent             VARCHAR(64) NOT NULL DEFAULT 'jessica',
  status            ENUM('pending_owner_approval','approved','sent','rejected','suppressed_dnc')
                    NOT NULL DEFAULT 'pending_owner_approval',
  approved_by       VARCHAR(255) NULL,
  approved_at       DATETIME NULL,
  sent_at           DATETIME NULL,
  provider_response TEXT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_email_status (status),
  KEY ix_recipient (recipient)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agent activity feed that drives the Mission Control room animations:
-- a room walks while its agent has open work and idles when the queue drains.
CREATE TABLE IF NOT EXISTS agent_activity (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent      VARCHAR(64) NOT NULL,
  state      ENUM('idle','working','blocked','needs_owner') NOT NULL DEFAULT 'idle',
  task       VARCHAR(255) NULL,
  detail     TEXT NULL,
  queue_depth INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_agent (agent)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO agent_activity (agent, state) VALUES
  ('goliath','idle'),('scout','idle'),('jessica','idle'),('shakespeare','idle'),
  ('scorsese','idle'),('einstein','idle'),('columbo','idle'),('mozart','idle'),
  ('pandora','idle'),('prospector','idle'),('rockefeller','idle'),('sherlock','idle');
