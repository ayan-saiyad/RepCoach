.PHONY: up down logs api worker seed test lint dashboard mobile

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f api worker

api:
	cd backend && .venv/bin/uvicorn app.main:app --reload

worker:
	cd backend && .venv/bin/python -m worker.main

seed:
	cd backend && .venv/bin/python -m app.scripts.seed_demo

test:
	cd backend && .venv/bin/pytest -q

lint:
	cd backend && .venv/bin/ruff check app worker ml tests migrations

dashboard:
	npm run dashboard:dev

mobile:
	npm run mobile:dev
