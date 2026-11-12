# PrintSheet Workbench — developer entry points.
#
# The default target prints help. `make up` builds and starts the whole stack,
# waits for health, then smoke-tests the public endpoints.

SHELL := /bin/bash
COMPOSE ?= docker compose
PYTHON ?= python3

.DEFAULT_GOAL := help

.PHONY: help setup api-setup worker-setup packer-setup web-setup contracts-setup
.PHONY: up down reset ps logs smoke verify test test-api test-worker test-packer test-web test-contracts
.PHONY: build fixtures e2e-fixtures api worker worker-gpu worker-gpu-setup web clean distclean test-web-full

help: ## Show the available targets
	@awk 'BEGIN {FS = ":.*##"; printf "PrintSheet Workbench\n\nUsage: make <target>\n\n"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

setup: api-setup worker-setup packer-setup web-setup contracts-setup ## Install all local dependencies

api-setup: ## Restore .NET packages
	cd api && dotnet restore PrintSheet.slnx

worker/.venv/.installed: worker/pyproject.toml
	cd worker && test -d .venv || $(PYTHON) -m venv .venv
	cd worker && .venv/bin/python -m pip install --quiet --upgrade pip
	cd worker && .venv/bin/pip install --quiet -e '.[dev]'
	touch worker/.venv/.installed

worker-setup: worker/.venv/.installed ## Create the worker venv and install dev extras

packer/.venv/.installed: packer/pyproject.toml
	cd packer && test -d .venv || $(PYTHON) -m venv .venv
	cd packer && .venv/bin/python -m pip install --quiet --upgrade pip
	cd packer && .venv/bin/pip install --quiet -e '.[dev]'
	touch packer/.venv/.installed

packer-setup: packer/.venv/.installed ## Create the packer venv and install dev extras

web-setup: ## Install web dependencies if node_modules is missing
	cd web && if [ ! -d node_modules ]; then npm ci; fi

.venv-contracts/.installed: scripts/requirements-dev.txt
	test -d .venv-contracts || $(PYTHON) -m venv .venv-contracts
	.venv-contracts/bin/python -m pip install --quiet --upgrade pip
	.venv-contracts/bin/pip install --quiet -r scripts/requirements-dev.txt
	touch .venv-contracts/.installed

contracts-setup: .venv-contracts/.installed ## Create the contract-validation venv

# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------

up: ## Build/start Compose, wait for health, smoke-test
	$(COMPOSE) up --build -d --wait --wait-timeout 240
	./scripts/smoke_test.py

down: ## Stop Compose, keep volumes
	$(COMPOSE) down

reset: ## Stop Compose and delete database + storage volumes
	$(COMPOSE) down -v

ps: ## Show container status
	$(COMPOSE) ps

logs: ## Follow logs
	$(COMPOSE) logs -f --tail=100

smoke: ## Verify a running stack over HTTP
	./scripts/smoke_test.py

# ---------------------------------------------------------------------------
# Tests and builds
# ---------------------------------------------------------------------------

verify: test ## Run every gate that must be green before a commit

test: test-contracts test-api test-worker test-packer test-web ## Run all test/validation gates

test-api: ## Domain/API tests
	cd api && dotnet test PrintSheet.slnx

test-worker: worker-setup ## Worker tests
	cd worker && .venv/bin/python -m pytest

test-packer: packer-setup ## Packer tests
	cd packer && .venv/bin/python -m pytest

test-web: web-setup ## Web type-check, build and lint
	cd web && npm run build && npm run lint

test-web-full: web-setup ## Full web test suite
	cd web && npm test -- --run

phase-gates: test-contracts test-api test-worker test-packer test-web-full ## Run complete phase validation gates

test-contracts: contracts-setup ## Validate JSON Schemas, examples and OpenAPI
	.venv-contracts/bin/python scripts/validate_contracts.py

build: ## Build API and web (worker/packer are installed editable)
	cd api && dotnet build PrintSheet.slnx
	cd web && npm run build

fixtures: packer-setup ## Regenerate realistic fixtures under fixtures/generated
	packer/.venv/bin/python scripts/generate_fixtures.py --clean

clean-preset: fixtures ## Verify one-click Clean only offers itself where it works
	worker/.venv/bin/python scripts/check_clean_preset.py

e2e-fixtures: fixtures ## Exercise intake, resize, pack, integrity and export against a running stack
	$(PYTHON) scripts/e2e_fixture_flow.py

# ---------------------------------------------------------------------------
# Native development (SQLite + local storage)
# ---------------------------------------------------------------------------

api: ## Run the API natively on :8080
	./scripts/run-api.sh

worker: ## Run the worker natively on :8000
	./scripts/run-worker.sh

worker-gpu: ## Run the worker with GPU enabled
	./scripts/run-worker-gpu.sh

worker-gpu-setup: ## Download the pinned Real-ESRGAN Linux binary and models
	./scripts/install-realesrgan-linux.sh

web: ## Run the Vite dev server on :5173
	./scripts/run-web.sh

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

clean: ## Remove build artifacts, generated fixtures and caches
	cd api && dotnet clean PrintSheet.slnx
	rm -rf web/dist fixtures/generated
	rm -rf worker/.pytest_cache packer/.pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +

distclean: clean ## Also remove venvs, node_modules and local databases
	rm -rf worker/.venv packer/.venv .venv-contracts web/node_modules
	rm -f api/src/PrintSheet.Api/printsheet.dev.db*
