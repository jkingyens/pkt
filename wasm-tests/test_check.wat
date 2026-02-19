(module
  (type (;0;) (func (result i32)))
  (type (;1;) (func (param i32 i32)))
  (type (;2;) (func (param i32 i32 i32 i32) (result i32)))
  (type (;3;) (func (param i32) (result i32)))
  (import "chrome:bookmarks/bookmarks" "get-tree" (func $get_tree (;0;) (type 0)))
  (import "env" "log" (func $log (;1;) (type 1)))
  (memory (;0;) 4)
  (global $heap_ptr (;0;) (mut i32) i32.const 1024)
  (export "memory" (memory 0))
  (export "cabi_realloc" (func 2))
  (export "main" (func 4))
  (func (;2;) (type 2) (param $old_ptr i32) (param $old_size i32) (param $align i32) (param $new_size i32) (result i32)
    (local $ptr i32) (local $needed i32)
    global.get $heap_ptr
    local.set $ptr
    local.get $ptr
    local.get $align
    i32.const 1
    i32.sub
    i32.add
    local.get $align
    i32.const 1
    i32.sub
    i32.const -1
    i32.xor
    i32.and
    local.set $ptr
    local.get $ptr
    local.get $new_size
    i32.add
    local.set $needed
    loop $grow_loop
      local.get $needed
      memory.size
      i32.const 65536
      i32.mul
      i32.gt_u
      if ;; label = @2
        i32.const 1
        memory.grow
        i32.const -1
        i32.eq
        if ;; label = @3
          unreachable
        end
        br $grow_loop
      end
    end
    local.get $needed
    global.set $heap_ptr
    local.get $ptr
  )
  (func $find_leaf (;3;) (type 3) (param $node_ptr i32) (result i32)
    (local $url_tag i32) (local $child_tag i32) (local $list_ptr i32) (local $list_len i32) (local $i i32) (local $res i32)
    local.get $node_ptr
    i32.const 28
    i32.add
    i32.load
    local.set $url_tag
    local.get $url_tag
    if ;; label = @1
      local.get $node_ptr
      i32.const 32
      i32.add
      i32.load
      local.get $node_ptr
      i32.const 36
      i32.add
      i32.load
      call $log
      local.get $node_ptr
      i32.const 36
      i32.add
      i32.load
      return
    end
    local.get $node_ptr
    i32.const 40
    i32.add
    i32.load
    local.set $child_tag
    local.get $child_tag
    if ;; label = @1
      local.get $node_ptr
      i32.const 44
      i32.add
      i32.load
      local.set $list_ptr
      local.get $node_ptr
      i32.const 48
      i32.add
      i32.load
      local.set $list_len
      i32.const 0
      local.set $i
      loop $child_iter
        local.get $i
        local.get $list_len
        i32.lt_u
        if ;; label = @3
          local.get $list_ptr
          local.get $i
          i32.const 4
          i32.mul
          i32.add
          i32.load
          call $find_leaf
          local.set $res
          local.get $res
          i32.const 0
          i32.gt_s
          if ;; label = @4
            local.get $res
            return
          end
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $child_iter
        end
      end
    end
    i32.const 0
  )
  (func (;4;) (type 0) (result i32)
    (local $res_ptr i32) (local $list_ptr i32) (local $list_len i32) (local $i i32) (local $found i32)
    call $get_tree
    local.set $res_ptr
    local.get $res_ptr
    i32.load
    i32.eqz
    if ;; label = @1
      local.get $res_ptr
      i32.const 4
      i32.add
      i32.load
      local.set $list_ptr
      local.get $res_ptr
      i32.const 8
      i32.add
      i32.load
      local.set $list_len
      i32.const 0
      local.set $i
      loop $root_iter
        local.get $i
        local.get $list_len
        i32.lt_u
        if ;; label = @3
          local.get $list_ptr
          local.get $i
          i32.const 4
          i32.mul
          i32.add
          i32.load
          call $find_leaf
          local.set $found
          local.get $found
          i32.const 0
          i32.gt_s
          if ;; label = @4
            local.get $found
            return
          end
          local.get $i
          i32.const 1
          i32.add
          local.set $i
          br $root_iter
        end
      end
    end
    i32.const -1
  )
)
