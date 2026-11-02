# syntax=docker/dockerfile:1
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

# Bootstrap Debian's trust store using apt's signed repository metadata, then
# use verified HTTPS. A session proxy CA is a build secret, never an image layer.
RUN --mount=type=secret,id=proxy_ca \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && cp /etc/ssl/certs/ca-certificates.crt /tmp/build-ca.pem \
    && if [ -f /run/secrets/proxy_ca ]; then cat /run/secrets/proxy_ca >> /tmp/build-ca.pem; fi \
    && apt-get -o Acquire::https::CAInfo=/tmp/build-ca.pem update \
    && apt-get -o Acquire::https::CAInfo=/tmp/build-ca.pem install -y --no-install-recommends \
       latexmk texlive-latex-base texlive-latex-recommended texlive-latex-extra \
       texlive-fonts-recommended texlive-xetex texlive-luatex fonts-lmodern fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* /tmp/build-ca.pem \
    && mkdir -p /source /work \
    && chmod 0755 /source /work

# These are repeated by the worker at runtime so uploads cannot weaken them.
ENV openin_any=p openout_any=p shell_escape=0
USER 10001:10001
WORKDIR /source
ENTRYPOINT ["/bin/sleep"]
CMD ["60"]
