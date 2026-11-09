FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY requirements-api.txt .
RUN pip install -r requirements-api.txt

COPY app ./app
RUN useradd --uid 10001 --create-home appuser && mkdir -p /data/uploads && chown -R appuser /data
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"
CMD ["sh", "-c", "uvicorn app.api:app --host 0.0.0.0 --port 8000 --workers ${API_WORKERS:-2} --proxy-headers"]
