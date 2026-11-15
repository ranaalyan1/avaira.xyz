FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Run as an unprivileged user (audit F-24). The data directory is under its home.
RUN useradd --create-home --uid 10001 avaira && chown -R avaira /app
USER avaira

EXPOSE 8001

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
