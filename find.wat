(module
  ;; Host Imports
  (import "chrome:bookmarks/bookmarks" "get-tree" (func $get_tree (result i32)))
  (import "env" "log" (func $log (param i32 i32)))

  ;; Memory
  (memory (export "memory") 4)

  ;; Allocator (cabi_realloc)
  (global $heap_ptr (mut i32) (i32.const 1024))
  (func (export "cabi_realloc") (param $old_ptr i32) (param $old_size i32) (param $align i32) (param $new_size i32) (result i32)
    (local $ptr i32)
    (local $needed i32)
    (local.set $ptr (global.get $heap_ptr))
    (local.set $ptr 
      (i32.and 
        (i32.add (local.get $ptr) (i32.sub (local.get $align) (i32.const 1))) 
        (i32.xor (i32.sub (local.get $align) (i32.const 1)) (i32.const -1))
      )
    )
    (local.set $needed (i32.add (local.get $ptr) (local.get $new_size)))
    (loop $grow_loop
      (if (i32.gt_u (local.get $needed) (i32.mul (memory.size) (i32.const 65536)))
        (then
          (if (i32.eq (memory.grow (i32.const 1)) (i32.const -1)) (then (unreachable)))
          (br $grow_loop)
        )
      )
    )
    (global.set $heap_ptr (local.get $needed))
    (local.get $ptr)
  )

  ;; Recursive Leaf Finder
  (func $find_leaf (param $node_ptr i32) (result i32)
    (local $tag i32)
    (local $list_ptr i32)
    (local $list_len i32)
    (local $i i32)
    (local $found i32)

    ;; 1. Check for URL (offset 28)
    (local.set $tag (i32.load (i32.add (local.get $node_ptr) (i32.const 28))))
    (if (local.get $tag)
      (then
        ;; Found it! Log the URL
        (call $log 
          (i32.load (i32.add (local.get $node_ptr) (i32.const 32)))
          (i32.load (i32.add (local.get $node_ptr) (i32.const 36)))
        )
        (return (i32.load (i32.add (local.get $node_ptr) (i32.const 36))))
      )
    )

    ;; 2. Check for Children (offset 40)
    (local.set $tag (i32.load (i32.add (local.get $node_ptr) (i32.const 40))))
    (if (local.get $tag)
      (then
        (local.set $list_ptr (i32.load (i32.add (local.get $node_ptr) (i32.const 44))))
        (local.set $list_len (i32.load (i32.add (local.get $node_ptr) (i32.const 48))))
        (local.set $i (i32.const 0))
        (loop $iter
          (if (i32.lt_u (local.get $i) (local.get $list_len))
            (then
              (call $find_leaf (i32.load (i32.add (local.get $list_ptr) (i32.mul (local.get $i) (i32.const 4)))))
              (local.set $found)
              (if (i32.gt_s (local.get $found) (i32.const 0)) (then (return (local.get $found))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $iter)
            )
          )
        )
      )
    )
    (i32.const 0)
  )

  (func (export "main") (result i32)
    (local $res_ptr i32)
    (local $list_ptr i32)
    (local $list_len i32)
    (local $i i32)
    (local $found i32)

    (call $get_tree)
    (local.set $res_ptr)
    (if (i32.eqz (i32.load (local.get $res_ptr)))
      (then
        (local.set $list_ptr (i32.load (i32.add (local.get $res_ptr) (i32.const 4))))
        (local.set $list_len (i32.load (i32.add (local.get $res_ptr) (i32.const 8))))
        (local.set $i (i32.const 0))
        (loop $iter
          (if (i32.lt_u (local.get $i) (local.get $list_len))
            (then
              (call $find_leaf (i32.load (i32.add (local.get $list_ptr) (i32.mul (local.get $i) (i32.const 4)))))
              (local.set $found)
              (if (i32.gt_s (local.get $found) (i32.const 0)) (then (return (local.get $found))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $iter)
            )
          )
        )
      )
    )
    (i32.const -1)
  )
)