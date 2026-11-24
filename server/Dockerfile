# Tonika-Server: App (statisch) + API mit Login + Notenerkennung (Audiveris)
# ---------- 1) Audiveris bauen (läuft auch auf ARM64 / Raspberry Pi) ----------
FROM eclipse-temurin:25-jdk AS audiveris
ARG AUDIVERIS_TAG=5.11.0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch ${AUDIVERIS_TAG} https://github.com/Audiveris/audiveris.git .
RUN ./gradlew --no-daemon -q :app:installDist \
 && mkdir -p /opt/audiveris \
 && cp -r app/build/install/*/* /opt/audiveris/ \
 && ls /opt/audiveris/bin
# Texterkennung für Titel/Komponist (Englisch, Deutsch)
ADD https://github.com/tesseract-ocr/tessdata/raw/4.1.0/eng.traineddata /opt/tessdata/eng.traineddata
ADD https://github.com/tesseract-ocr/tessdata/raw/4.1.0/deu.traineddata /opt/tessdata/deu.traineddata

# ---------- 2) Laufzeit ----------
FROM eclipse-temurin:25-jre
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv poppler-utils fontconfig libfreetype6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=audiveris /opt/audiveris /opt/audiveris
COPY --from=audiveris /opt/tessdata /opt/tessdata
ENV TESSDATA_PREFIX=/opt/tessdata AUDIVERIS=/opt/audiveris/bin/Audiveris
RUN python3 -m venv /venv
COPY requirements.txt /tmp/requirements.txt
RUN /venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /app
COPY app.py /app/app.py
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data STATIC_DIR=/site
EXPOSE 8000
CMD ["/venv/bin/uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
