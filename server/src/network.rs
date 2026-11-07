//! Startup-only address resolution, including Fly's UDP service interface.
use anyhow::{Context, Result};
use std::net::{SocketAddr, ToSocketAddrs};
pub fn udp_bind_address(value: &str) -> Result<SocketAddr> {
    if let Ok(address) = value.parse::<SocketAddr>() {
        return Ok(address);
    }
    value
        .to_socket_addrs()
        .context("resolve UDP bind address")?
        .find(SocketAddr::is_ipv4)
        .context("UDP hostname has no IPv4 address")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_and_hostname_binds_are_resolved_without_wildcard_fallback() {
        assert_eq!(
            udp_bind_address("127.0.0.1:50000").unwrap().to_string(),
            "127.0.0.1:50000"
        );
        assert_eq!(
            udp_bind_address("[::1]:50000").unwrap().to_string(),
            "[::1]:50000"
        );
        let local = udp_bind_address("localhost:50000").unwrap();
        assert!(local.ip().is_loopback() && local.is_ipv4());
        assert_eq!(local.port(), 50000);
        assert!(udp_bind_address("invalid address").is_err());
    }
}
