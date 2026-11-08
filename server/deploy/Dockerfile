FROM rust:1.93.1-bookworm AS build
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY server/src ./server/src
COPY server/config ./server/config
COPY misc/web/multiplayer ./misc/web/multiplayer
RUN cargo build --release --locked --manifest-path server/Cargo.toml --bin zone-server
FROM debian:bookworm-slim
RUN groupadd --gid 10001 zone && useradd --uid 10001 --gid zone --no-create-home zone && mkdir /data && chown zone:zone /data
COPY --from=build /src/server/target/release/zone-server /usr/local/bin/zone-server
USER zone
ENV ZONE_HTTP_ADDR=0.0.0.0:8082 ZONE_UDP_ADDR=0.0.0.0:50000 ZONE_DATABASE=/data/zone.sqlite
EXPOSE 8082/tcp 50000/udp
VOLUME /data
ENTRYPOINT ["/usr/local/bin/zone-server"]
