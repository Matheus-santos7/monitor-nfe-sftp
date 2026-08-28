-- Schema do histórico do monitor. Roda na subida do processo, é idempotente.
-- Mora no mesmo Postgres do n8n, em schema separado (ver ADR-004).

-- init-data.sh só roda em volume novo; aqui garante o schema em banco já existente.
CREATE SCHEMA IF NOT EXISTS monitor;

CREATE TABLE IF NOT EXISTS monitor.execucoes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identificador      TEXT NOT NULL,
    iniciado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalizado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
    integracao_ok      BOOLEAN NOT NULL,
    total_ausentes     INTEGER NOT NULL,
    teto_periodo_ini   DATE,
    teto_periodo_fim   DATE,
    fake_nota          TEXT,
    resultado_bruto    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execucoes_iniciado_em ON monitor.execucoes(iniciado_em);

CREATE TABLE IF NOT EXISTS monitor.series_resultado (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execucao_id        UUID NOT NULL REFERENCES monitor.execucoes(id) ON DELETE CASCADE,
    serie              INTEGER NOT NULL,
    cnpj               TEXT,
    total              INTEGER NOT NULL,
    min_numero         INTEGER NOT NULL,
    max_numero         INTEGER NOT NULL,
    teto_ml            INTEGER,
    ultima_ml_no_ftp   BOOLEAN,
    total_ausentes     INTEGER NOT NULL,
    pulos              JSONB NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_series_resultado_execucao ON monitor.series_resultado(execucao_id);

CREATE TABLE IF NOT EXISTS monitor.diagnosticos (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    criado_em            TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
    invoice_id           TEXT NOT NULL,
    chave                TEXT,
    numero               INTEGER NOT NULL,
    serie                INTEGER NOT NULL,
    notificacao_recebida BOOLEAN NOT NULL,
    entrega_enviada      BOOLEAN NOT NULL,
    precisa_admin        BOOLEAN NOT NULL,
    proxima_acao         TEXT NOT NULL,
    resultado_final      TEXT,
    relatorio_bruto      JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diagnosticos_criado_em ON monitor.diagnosticos(criado_em);
