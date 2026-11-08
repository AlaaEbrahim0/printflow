FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY packer/pyproject.toml packer/README.md ./
COPY packer/printsheet_packer ./printsheet_packer
COPY contracts/jsonschema ./contracts/jsonschema
RUN pip install .

CMD ["printsheet-packer-runner"]
