#![cfg(target_os = "linux")]

use glib::prelude::*;

// Run optimized too: the affected GLib code can discard the C output write
// under optimization and dereference null (RUSTSEC-2024-0429).
#[test]
fn variant_string_iteration_survives_optimized_forward_and_reverse_access() {
    let variant = ["first", "middle", "last"].to_variant();
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some("middle"));
    assert_eq!(iter.next_back(), None);
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        vec!["last", "middle", "first"]
    );
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.nth(1), Some("middle"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), None);
}
