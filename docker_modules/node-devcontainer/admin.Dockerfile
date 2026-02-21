FROM dhi.io/docker:29-cli-dev

RUN apt-get update && \
    apt-get install -y ca-certificates curl gnupg && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian trixie stable" | tee /etc/apt/sources.list.d/docker.list >/dev/null && \
    apt-get update && \
    apt-get install --no-install-recommends -y \
        docker-model-plugin \
        git \
        ripgrep \
        gzip \
        zip \
        unzip \
        less \
        openssh-client && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY .vimrc /root/.vimrc

VOLUME /workspace
WORKDIR /workspace

CMD ["sleep", "infinity"]