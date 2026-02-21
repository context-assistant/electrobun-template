FROM node:25

RUN apt-get update && \
    apt-get install --no-install-recommends -y \
        curl \
        vim \
        ncurses-term \
        git \
        gzip \
        zip \
        unzip \
        less \
        ripgrep \
        fd-find \
        python3 \
        bash-completion \
        build-essential \
        openssh-client \
        gnupg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN echo 'export PATH=$PATH:~/.local/bin' >> /etc/profile

COPY .vimrc /root/.vimrc

VOLUME /workspace
WORKDIR /workspace

# claude-code
ENV ANTHROPIC_AUTH_TOKEN=ollama
ENV ANTHROPIC_BASE_URL=http://localhost:11434
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV ANTHROPIC_MODEL=qwen3-coder-next

# codex and qwen-code
ENV OPENAI_BASE_URL="http://localhost:11434/v1"

# qwen-code
ENV OPENAI_API_KEY="sk-xxx"
ENV OPENAI_MODEL="qwen3-coder-next"


CMD ["sleep", "infinity"]