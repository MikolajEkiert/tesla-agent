FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
# keys/ (public-key.pem, private-key.pem) is mounted or added only for the fleet adapter.

# Run as an unprivileged user. This process holds the Tesla refresh token and
# the session-signing secret, so any code-execution bug in it should not also
# come with root inside the container. The uid owns /app/data because that is
# where the token and passkey databases are written.
# A fixed uid of our own rather than one borrowed from the host: /app/data is a
# bind mount, and which host account happens to hold uid 1000 varies (on this
# server it is `opc`, not `ubuntu`). deploy.sh chowns the mount to this same
# number, so ownership is stated once here and matched there. A mismatch would
# surface as the container silently failing to write the Tesla token database —
# i.e. a forced re-login after every deploy, not an obvious error.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin amp \
    && mkdir -p /app/data \
    && chown -R amp:amp /app
USER amp

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
