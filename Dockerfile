FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ARG enable_mecab=1
ARG MECAB_NEOLOGD_COMMIT=abc61e33d8be3d0ead202e6b1df064c72d5ccf11

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini git ca-certificates curl file g++ make pkg-config python3 sudo xz-utils \
    mecab libmecab-dev mecab-ipadic-utf8 \
    libcairo2-dev libjpeg62-turbo-dev libpango1.0-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
  && apt-get install -y --no-install-recommends patch \
  && rm -rf /var/lib/apt/lists/*

RUN if [ "$enable_mecab" -ne 0 ]; then \
    git init /opt/mecab-ipadic-neologd \
    && cd /opt/mecab-ipadic-neologd \
    && git remote add origin https://github.com/neologd/mecab-ipadic-neologd.git \
    && git fetch --depth 1 origin "$MECAB_NEOLOGD_COMMIT" \
    && git checkout --detach FETCH_HEAD \
    && ./bin/install-mecab-ipadic-neologd -n -y \
    && cd / \
    && rm -rf /opt/mecab-ipadic-neologd \
    && echo "dicdir = /usr/lib/x86_64-linux-gnu/mecab/dic/mecab-ipadic-neologd/" > /etc/mecabrc; \
  fi

WORKDIR /ai

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps \
  && npm cache clean --force

COPY --chown=node:node . .
RUN npm run build \
  && chown -R node:node /ai

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
