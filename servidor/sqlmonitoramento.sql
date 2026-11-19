-- Banco de histórico do Monitor NF-e (MySQL 8). O monitor cria estas tabelas sozinho na subida
-- (CREATE TABLE IF NOT EXISTS), se o usuário tiver CREATE. Sem essa permissão, o DBA roda este arquivo.
--
-- 1) Usuário do monitor, com acesso SÓ a este banco (troque a senha; o host é o do servidor do monitor):
--    CREATE DATABASE IF NOT EXISTS sqlmonitoramento CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--    CREATE USER IF NOT EXISTS 'matheus'@'implantacao.nerus1' IDENTIFIED BY '<senha forte>';
--    GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON sqlmonitoramento.* TO 'matheus'@'implantacao.nerus1';
--
-- 2) Tabelas:
USE sqlmonitoramento;

CREATE TABLE IF NOT EXISTS monitor_checagem (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  em DATETIME(3) NOT NULL,
  cliente VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL,
  duracao_ms INT UNSIGNED NULL,
  notas_ausentes INT UNSIGNED NOT NULL DEFAULT 0,
  avisos TEXT NULL,
  KEY ix_checagem_cliente_em (cliente, em)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS monitor_evento (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  em DATETIME(3) NOT NULL,
  cliente VARCHAR(120) NOT NULL,
  tipo VARCHAR(30) NOT NULL,
  nota VARCHAR(30) NOT NULL DEFAULT '',
  texto VARCHAR(500) NOT NULL,
  duracao_min INT NULL,
  UNIQUE KEY ux_evento (cliente, em, tipo, nota),
  KEY ix_evento_cliente_tipo_em (cliente, tipo, em)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS monitor_ciclo (
  execucao VARCHAR(40) NOT NULL,
  cliente VARCHAR(120) NOT NULL,
  origem VARCHAR(10) NOT NULL,
  quem VARCHAR(64) NULL,
  sombra TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL,
  inicio DATETIME(3) NOT NULL,
  fim DATETIME(3) NOT NULL,
  mensagens INT UNSIGNED NOT NULL DEFAULT 0,
  sem_entrega INT UNSIGNED NOT NULL DEFAULT 0,
  etapa_falha VARCHAR(60) NULL,
  erro VARCHAR(500) NULL,
  PRIMARY KEY (cliente, execucao),
  KEY ix_ciclo_cliente_inicio (cliente, inicio)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
