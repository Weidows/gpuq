# gpuq server image — Python 3.11 slim, no pip deps (stdlib only)
# GPU visibility requires the host to run the NVIDIA Container Toolkit
# (nvidia-container-runtime); see README "Docker" section.
FROM python:3.11-slim

LABEL org.opencontainers.image.title="gpuq" \
      org.opencontainers.image.description="GPU job queue with WebUI + metrics" \
      org.opencontainers.image.source="https://github.com/Weidows/gpuq"

# NOTE: no apt deps needed. nvidia-smi + CUDA libs are injected by the
# NVIDIA Container Toolkit at runtime (--gpus all), not installed here.

WORKDIR /opt/gpuq
# webui/ lives inside the gpuq package, so copying the package covers it
COPY gpuq/ ./gpuq/
COPY config.example.json ./config.example.json

ENV GPUQ_HOST=0.0.0.0 \
    GPUQ_PORT=8765 \
    GPUQ_DATA=/data

VOLUME ["/data"]
EXPOSE 8765

# Task workdirs: mount your training code / datasets here and submit with
# "cwd": "/work" — see README.
VOLUME ["/work"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/api/system', timeout=2).status==200 else 1)"

ENTRYPOINT ["python", "-m", "gpuq.cli", "serve"]
CMD ["--host", "0.0.0.0", "--port", "8765"]
