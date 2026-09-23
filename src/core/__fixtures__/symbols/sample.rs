extern crate alloc as my_alloc;

use std::collections::HashMap;
use super::sibling;

pub const MAX_RETRIES: u32 = 3;
static COUNTER: u32 = 0;

pub mod config {
    pub fn parse_config(path: &str) -> Config {
        Config { path: path.to_string() }
    }
}

pub struct Config {
    path: String,
}

pub union Bits {
    i: u32,
    f: f32,
}

pub enum Mode {
    Read,
    Write(u8),
}

pub trait Render {
    type Output;
    fn render(&self) -> Self::Output;
}

pub type Alias = HashMap<String, u32>;

impl Render for Config {
    type Output = String;
    fn render(&self) -> String {
        let mut total = 0;
        total = base + extra;
        total += 1;
        self.path.clone()
    }
}

fn generic<'a, T: Clone, const N: usize>(x: &'a T) -> T where T: Default {
    x.clone()
}

struct Holder<T: Clone = u8> {
    value: T,
}

macro_rules! make {
    ($name:ident) => {};
}

fn pattern(p: Point) {
    let Point { x, y: renamed } = p;
    match p.x {
        LOW..=HIGH => {}
        _ => {}
    }
}

fn uses_iter<I: Iterator<Item = u8>>(i: I) {}
