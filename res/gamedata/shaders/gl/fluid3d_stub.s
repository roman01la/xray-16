-- Preserve the original fluid visual's transparent back-to-front sort. The
-- native WebGPU fluid visual submits simulation/compositing instead of drawing
-- this marker material.
function normal(shader, t_base, t_second, t_detail)
    shader:begin("stub_default", "stub_default")
        :zb(true, false)
        :blend(true, blend.one, blend.one)
        :sorting(2, true)
    shader:sampler("s_base"):texture(t_base):clamp():f_linear()
end
