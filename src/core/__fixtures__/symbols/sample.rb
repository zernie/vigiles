require "json"

MAX_RETRIES = 3
counter = 0
counter += 1
total = base + extra

module Billing
  RATE = 5

  class Invoice < Base
    attr_reader :total

    def full_name(first, last = "x", *rest, key: 1, **opts, &blk)
      "#{first} #{last}"
    end

    def self.build
      new
    end

    def total=(value)
      @total = value
    end

    alias_method :name, :full_name
    alias label full_name

    def ==(other)
      true
    end
  end

  class Nested::Deep
    def inner; end
  end
end

def top_level_helper
  case input
  in {name: String => who}
    who
  in ^expected
    nil
  end
end

class Widget
  def render
  end
end
