use super::*;

fn valid_manifest() -> serde_json::Value {
    serde_json::json!({
        "ok":true,"product":"pometodo","platform":"windows-x86_64",
        "channel":crate::distribution::UPDATE_CHANNEL,"installerType":"nsis","version":"0.1.1",
        "downloadUrl":format!("https://www.shiliux.com{}0.1.1/PomeTodo-setup.exe", crate::distribution::DOWNLOAD_PATH),
        "sha256":"a".repeat(64),"byteLength":1024,"releaseNotes":"修复与改进",
        "publishedAt":"2026-09-06T08:00:00Z"
    })
}

#[test]
fn accepts_own_valid_installer_manifest_and_windows_bom() {
    let text = valid_manifest().to_string();
    assert_eq!(parse_manifest(&text).unwrap().version, "0.1.1");
    assert!(parse_manifest(&format!("\u{feff}{text}")).is_ok());
}

#[test]
fn rejects_installer_from_the_other_distribution_even_with_valid_integrity() {
    let (other_channel, other_path) = if crate::distribution::OFFICIAL_SERVICES {
        ("byok", "/downloads/pometodo/byok/releases/")
    } else {
        ("standalone", "/downloads/pometodo/releases/")
    };
    let mut doc = valid_manifest();
    doc["channel"] = other_channel.into();
    assert!(parse_manifest(&doc.to_string()).is_err());
    doc = valid_manifest();
    doc["downloadUrl"] =
        format!("https://www.shiliux.com{other_path}0.1.1/PomeTodo-setup.exe").into();
    assert!(parse_manifest(&doc.to_string()).is_err());
}

#[test]
fn rejects_other_products_channels_and_malformed_integrity() {
    for (key, value) in [
        ("product", serde_json::json!("pometype")),
        ("channel", serde_json::json!("store")),
        ("platform", serde_json::json!("windows-arm64")),
        ("installerType", serde_json::json!("portable")),
        ("sha256", serde_json::json!("bad")),
        ("byteLength", serde_json::json!(0)),
        ("byteLength", serde_json::json!(1024u64 * 1024 * 1024)),
        ("version", serde_json::json!("../../evil")),
        ("version", serde_json::json!("1.0.01")),
        ("ok", serde_json::json!(false)),
    ] {
        let mut doc = valid_manifest();
        doc[key] = value;
        assert!(
            parse_manifest(&doc.to_string()).is_err(),
            "accepted invalid {key}"
        );
    }
}

#[test]
fn rejects_cross_product_urls_credentials_queries_and_traversal() {
    for url in [
        "http://www.shiliux.com/downloads/pometodo/releases/a.exe",
        "https://evil.example/downloads/pometodo/releases/a.exe",
        "https://www.shiliux.com/downloads/pometype/releases/a.exe",
        "https://www.shiliux.com/downloads/pometodo/releases/../../pometype/a.exe",
        "https://user:password@www.shiliux.com/downloads/pometodo/releases/a.exe",
        "https://www.shiliux.com/downloads/pometodo/releases/a.exe?redirect=evil",
        "https://www.shiliux.com/downloads/pometodo/releases/a%2f.exe",
        "https://www.shiliux.com/downloads/pometodo/releases/a.exe#fragment",
    ] {
        let mut doc = valid_manifest();
        doc["downloadUrl"] = url.into();
        assert!(
            parse_manifest(&doc.to_string()).is_err(),
            "accepted unsafe URL"
        );
    }
}

#[test]
fn stable_versions_compare_numerically_and_never_offer_downgrades() {
    assert!(is_newer("0.1.10", "0.1.9").unwrap());
    assert!(!is_newer("0.1.1", "0.1.1").unwrap());
    assert!(!is_newer("0.1.1", "0.2.0").unwrap());
    for value in [
        "v1.0.0",
        "1.0",
        "1.0.0.0",
        "1.0.0-beta",
        "1.0.01",
        "4294967296.0.0",
    ] {
        assert!(version_parts(value).is_err());
    }
}

#[test]
fn corrupted_truncated_or_appended_installer_cannot_pass_final_check() {
    let mut manifest = parse_manifest(&valid_manifest().to_string()).unwrap();
    let bytes = b"verified installer fixture";
    manifest.byte_length = bytes.len() as u64;
    manifest.sha256 = format!("{:x}", sha2::Sha256::digest(bytes));
    assert!(verify_reader(&mut &bytes[..], &manifest).is_ok());
    assert!(verify_reader(&mut &bytes[..bytes.len() - 1], &manifest).is_err());
    let mut modified = bytes.to_vec();
    modified[0] ^= 1;
    assert!(verify_reader(&mut &modified[..], &manifest).is_err());
    let mut extra = bytes.to_vec();
    extra.push(0);
    assert!(verify_reader(&mut &extra[..], &manifest).is_err());
}

#[test]
fn another_update_operation_is_rejected_and_gate_releases_after_failure() {
    let busy = std::sync::atomic::AtomicBool::new(false);
    let guard = claim(&busy).unwrap();
    assert!(claim(&busy).is_err());
    drop(guard);
    assert!(claim(&busy).is_ok());
}

#[test]
fn store_detection_fails_closed_on_unknown_windows_status() {
    assert_eq!(package_mode(122).unwrap(), true);
    assert_eq!(package_mode(15700).unwrap(), false);
    assert!(package_mode(5).is_err());
}

#[test]
fn update_restart_opens_window_without_changing_normal_minimized_startup() {
    let args = |values: &[&str]| {
        values
            .iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>()
    };
    assert!(should_show_on_start(true, args(&["--show-after-update"])));
    assert!(!should_show_on_start(true, args(&["--autostart"])));
    assert!(!should_show_on_start(true, args(&[])));
    assert!(should_show_on_start(false, args(&[])));
    assert!(!should_show_on_start(true, args(&["=--show-after-update"])));
}

#[test]
fn real_http_download_checks_bytes_and_removes_failed_files() {
    let payload = b"synthetic installer bytes";
    for case in ["success", "bad_hash", "truncated", "bad_length", "redirect"] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/fixture.exe", listener.local_addr().unwrap());
        let served = if case == "truncated" {
            &payload[..4]
        } else {
            &payload[..]
        };
        let response = if case == "redirect" {
            b"HTTP/1.1 302 Found\r\nLocation: /should-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        } else {
            let size = if case == "bad_length" {
                payload.len() + 1
            } else {
                payload.len()
            };
            [
                format!("HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
                served,
            ]
            .concat()
        };
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 16384);
            }
            let _ = stream.write_all(&response);
            drop(stream);
            if case == "redirect" {
                listener.set_nonblocking(true).unwrap();
                let start = std::time::Instant::now();
                while start.elapsed() < Duration::from_millis(300) {
                    if listener.accept().is_ok() {
                        return true;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            false
        });
        let mut manifest = parse_manifest(&valid_manifest().to_string()).unwrap();
        // Only this private test bypasses the production manifest URL parser.
        manifest.download_url = url;
        manifest.byte_length = payload.len() as u64;
        manifest.sha256 = if case == "bad_hash" {
            "0".repeat(64)
        } else {
            format!("{:x}", Sha256::digest(payload))
        };
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("fixture.exe");
        let mut received = Vec::new();
        let outcome = tauri::async_runtime::block_on(async {
            let http = client_builder(Duration::from_secs(3))
                .no_proxy()
                .build()
                .unwrap();
            download_installer(&manifest, &path, http, |bytes| received.push(bytes)).await
        });
        assert!(!server.join().unwrap(), "redirect was followed");
        if case == "success" {
            outcome.unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), payload);
            assert_eq!(received.first(), Some(&0));
            assert_eq!(received.last(), Some(&manifest.byte_length));
        } else {
            assert!(outcome.is_err(), "accepted {case}");
            assert!(!path.exists(), "retained invalid file for {case}");
        }
    }
}
