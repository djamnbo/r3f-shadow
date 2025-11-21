import { useRef, useState, useEffect, useMemo, Suspense } from 'react';
import { Canvas, useFrame, useThree, useGraph } from '@react-three/fiber';
import {
  OrthographicCamera,
  OrbitControls,
  KeyboardControls,
  KeyboardControlsEntry,
  useKeyboardControls,
  useGLTF,
  useAnimations,
  Html
} from '@react-three/drei';
import {
  Physics,
  RigidBody,
  RapierRigidBody,
  CapsuleCollider,
  BallCollider,
  useRapier
} from '@react-three/rapier';
import {
  Group,
  Vector3,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshBasicMaterial,
  GreaterDepth,
  MathUtils,
  Color,
  DoubleSide,
  Vector3 as ThreeVector3,
  BufferAttribute,
  BufferGeometry,
  Quaternion,
  Object3D
} from 'three';
import { SkeletonUtils } from 'three-stdlib';
import { useControls } from 'leva';

// V113: TS 에러 수정 (0xffffffff -> undefined) 및 안정화

enum Controls {
  forward = 'forward',
  backward = 'backward',
  left = 'left',
  right = 'right',
  jump = 'jump',
  toggleMode = 'toggleMode',
  interact = 'interact',
  inventory = 'inventory',
  special = 'special',
  switchChar = 'switchChar',
  menu = 'menu',
}

const keyboardMap: KeyboardControlsEntry<Controls>[] = [
  { name: Controls.forward, keys: ['ArrowUp', 'KeyW'] },
  { name: Controls.backward, keys: ['ArrowDown', 'KeyS'] },
  { name: Controls.left, keys: ['ArrowLeft', 'KeyA'] },
  { name: Controls.right, keys: ['ArrowRight', 'KeyD'] },

  { name: Controls.jump, keys: ['KeyS'] },
  { name: Controls.toggleMode, keys: ['KeyQ'] },
  { name: Controls.interact, keys: ['KeyA'] },
  { name: Controls.inventory, keys: ['KeyW'] },
  { name: Controls.special, keys: ['KeyD'] },
  { name: Controls.switchChar, keys: ['KeyE'] },

  { name: Controls.menu, keys: ['Escape'] },
];

const RUN_SPEED = 4.6;
const WALK_SPEED = 2;
const JUMP_FORCE = 7.2;
const DASH_JUMP_FORCE = 4.8;
const DASH_SPEED = 6.2;
const AIR_SPEED = 2;
const JUMP_ANIM_START_TIME = 0.6;
const START_POSITION: [number, number, number] = [-25, 5, 14];

const BASE_ZOOM = 84;
const BASE_DISTANCE = 40;

// 🚀 [수정됨] 동적 시야각 컴포넌트
const DynamicVisionCone = ({
                             parentBody,
                             rayCount = 60,
                             fov = 60,
                             viewDistance = 10
                           }: {
  parentBody: React.RefObject<RapierRigidBody | null>,
  rayCount?: number,
  fov?: number,
  viewDistance?: number
}) => {
  const { world, rapier } = useRapier();
  const meshRef = useRef<Mesh>(null);
  const geometryRef = useRef<BufferGeometry>(null);

  const vertexCount = rayCount + 2;
  const positions = useMemo(() => new Float32Array(vertexCount * 3).fill(0), [vertexCount]);
  const indices = useMemo(() => {
    const idx = [];
    for (let i = 1; i <= rayCount; i++) {
      idx.push(0, i, i + 1);
    }
    return new Uint16Array(idx);
  }, [rayCount]);

  useFrame(() => {
    if (!meshRef.current || !geometryRef.current || !world || !rapier) return;
    if (!parentBody.current) return;

    const mesh = meshRef.current;
    mesh.updateMatrixWorld();

    const worldPos = new ThreeVector3();
    const worldDir = new ThreeVector3();
    mesh.getWorldPosition(worldPos);
    mesh.getWorldDirection(worldDir);

    if (isNaN(worldDir.x) || isNaN(worldDir.z)) return;

    // 레이 시작점: 캐릭터 중심 (높이 y는 메쉬 위치에 따름)
    const rayOrigin = {
      x: worldPos.x,
      y: worldPos.y,
      z: worldPos.z
    };

    const baseAngle = Math.atan2(worldDir.x, worldDir.z);
    const halfFov = MathUtils.degToRad(fov / 2);
    const angleStep = MathUtils.degToRad(fov) / rayCount;
    const startAngle = baseAngle - halfFov;

    const posAttr = geometryRef.current.attributes.position;
    posAttr.setXYZ(0, 0, 0, 0);

    const excludeBody = parentBody.current;

    for (let i = 0; i <= rayCount; i++) {
      const angle = startAngle + (angleStep * i);
      const dx = Math.sin(angle);
      const dz = Math.cos(angle);
      const rayDirection = { x: dx, y: 0, z: dz };

      const ray = new rapier.Ray(rayOrigin, rayDirection);

      // 🚀 [핵심 수정] 0xffffffff -> undefined
      // undefined를 넣으면 "모든 그룹"과 충돌합니다. (기본값)
      const hit = world.castRay(
        ray,
        viewDistance,
        true,        // solid: true
        undefined,   // groups: undefined = Everything
        undefined,
        excludeBody, // filterExcludeRigidBody: 나 자신 제외
        undefined
      );

      let dist = hit ? (hit as any).toi : viewDistance;
      if (isNaN(dist)) dist = viewDistance;

      const localAngle = -halfFov + (angleStep * i);
      let localX = Math.sin(localAngle) * dist;
      let localZ = Math.cos(localAngle) * dist;

      if (isNaN(localX)) localX = 0;
      if (isNaN(localZ)) localZ = 0;

      posAttr.setXYZ(i + 1, localX, 0, localZ);
    }

    posAttr.needsUpdate = true;
    try { geometryRef.current.computeBoundingSphere(); } catch (e) {}
  });

  return (
    <mesh ref={meshRef} position={[0, 1.0, 0]} frustumCulled={false}>
      <bufferGeometry ref={geometryRef}>
        <bufferAttribute
          attach="attributes-position"
          count={vertexCount}
          array={positions}
          itemSize={3}
        />
        <bufferAttribute
          attach="index"
          count={indices.length}
          array={indices}
          itemSize={1}
        />
      </bufferGeometry>
      <meshBasicMaterial
        color="#ff3333"
        transparent
        opacity={0.4}
        side={DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
};

// Enemy 컴포넌트
const Enemy = ({ path }: { path: Vector3[] }) => {
  const rigidBody = useRef<RapierRigidBody>(null);
  const groupRef = useRef<Group>(null);
  const { scene, animations } = useGLTF('/models/hero.glb');

  const clone = useMemo(() => SkeletonUtils.clone(scene), [scene]);
  const { actions } = useAnimations(animations, groupRef);

  const [currentPointIndex, setCurrentPointIndex] = useState(0);
  const [isWaiting, setIsWaiting] = useState(false);

  useEffect(() => {
    clone.traverse((child: any) => {
      if (child.isMesh) {
        child.material = child.material.clone();
        child.material.color = new Color('#556644');
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }, [clone]);

  useFrame((state, delta) => {
    if (!rigidBody.current || isWaiting || path.length === 0) return;

    const currentPos = rigidBody.current.translation();

    if (currentPos.y < -10) {
      rigidBody.current.setTranslation(path[0], true);
      rigidBody.current.setLinvel({x:0, y:0, z:0}, true);
      return;
    }

    const targetPos = path[currentPointIndex];
    const direction = new Vector3(targetPos.x - currentPos.x, 0, targetPos.z - currentPos.z);
    const distance = direction.length();

    if (distance < 0.5) {
      setIsWaiting(true);
      const walkAction = actions['Walk'];
      const idleAction = actions['Idle'];
      walkAction?.fadeOut(0.2);
      idleAction?.reset().fadeIn(0.2).play();

      setTimeout(() => {
        const nextIndex = (currentPointIndex + 1) % path.length;
        setCurrentPointIndex(nextIndex);
        setIsWaiting(false);

        idleAction?.fadeOut(0.2);
        walkAction?.reset().fadeIn(0.2).play();
      }, 2000);

      rigidBody.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      direction.normalize();
      const moveSpeed = 2;

      rigidBody.current.setLinvel({
        x: direction.x * moveSpeed,
        y: rigidBody.current.linvel().y,
        z: direction.z * moveSpeed
      }, true);

      const rotation = Math.atan2(direction.x, direction.z);
      if (groupRef.current) {
        groupRef.current.rotation.y = rotation;
      }

      const walkAction = actions['Walk'];
      if (walkAction && !walkAction.isRunning()) {
        walkAction.reset().play();
      }
    }
  });

  return (
    <RigidBody
      ref={rigidBody}
      position={path[0]}
      enabledRotations={[false, false, false]}
      colliders={false}
      friction={0}
      gravityScale={3}
    >
      <CapsuleCollider args={[0.75, 0.3]} position={[0, 1, 0]} />

      <group ref={groupRef}>
        <primitive object={clone} scale={0.8} position={[0, 0, 0]} />
        <DynamicVisionCone parentBody={rigidBody} />
      </group>
    </RigidBody>
  );
};

// ... (나머지 코드는 V102와 동일하게 유지) ...

const PlayerVisuals = ({
                         scene,
                         animations,
                         currentAnimation,
                         isGhost = false
                       }: {
  scene: Group,
  animations: any[],
  currentAnimation: string,
  isGhost?: boolean
}) => {
  const groupRef = useRef<Group>(null);
  const { actions } = useAnimations(animations, groupRef);

  useEffect(() => {
    const action = actions[currentAnimation];
    if (action) {
      action.reset();
      if (currentAnimation === "Jump" || currentAnimation === "Dash") {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        if (currentAnimation === "Jump") {
          action.time = JUMP_ANIM_START_TIME;
        }
      } else {
        action.setLoop(LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      }
      action.fadeIn(0.2).play();
      return () => { action.fadeOut(0.2); };
    }
  }, [currentAnimation, actions]);

  useEffect(() => {
    if (isGhost) {
      scene.traverse((child: any) => {
        if (child.isMesh) {
          child.material = new MeshBasicMaterial({
            color: 0xff4444,
            transparent: true,
            opacity: 0.3,
            depthFunc: GreaterDepth,
            depthWrite: false,
          });
          child.castShadow = false;
          child.receiveShadow = false;
        }
      });
    } else {
      scene.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
    }
  }, [scene, isGhost]);

  return (
    <group ref={groupRef}>
      <primitive object={scene} />
    </group>
  );
};

const Player = ({
                  isLive,
                  orbitControlsRef
                }: {
  isLive: boolean,
  orbitControlsRef: React.MutableRefObject<any>
}) => {
  const rigidBody = useRef<RapierRigidBody>(null);
  const rotationGroup = useRef<Group>(null);
  const posDebugRef = useRef<HTMLDivElement>(null);

  const [sub, get] = useKeyboardControls<Controls>();
  const { world, rapier } = useRapier();

  const isLiveRef = useRef(isLive);
  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);

  const { scene, animations } = useGLTF('/models/hero.glb');
  const ghostScene = useMemo(() => SkeletonUtils.clone(scene), [scene]);

  const [animation, setAnimation] = useState("Idle");
  const [isCrouching, setIsCrouching] = useState(false);
  const isCrouchingRef = useRef(isCrouching);
  useEffect(() => { isCrouchingRef.current = isCrouching; }, [isCrouching]);

  const isMovingRef = useRef(false);
  const inAir = useRef(false);

  const { camera } = useThree();

  useEffect(() => {
    const unsubscribeJump = sub(
      (state) => state.jump,
      (pressed) => {
        if (pressed && rigidBody.current) {
          if (inAir.current) return;

          const playerPos = rigidBody.current.translation();
          const rayOrigin = { x: playerPos.x, y: playerPos.y + 0.05, z: playerPos.z };
          const rayDir = { x: 0, y: -1, z: 0 };
          const ray = new rapier.Ray(rayOrigin, rayDir);

          const hit = world.castRay(ray, 0.2, true, 0xffffffff, null, rigidBody.current);

          if (hit) {
            const isRunning = isMovingRef.current && !isCrouchingRef.current;
            let jumpVelocity = JUMP_FORCE;
            if (isRunning) jumpVelocity = DASH_JUMP_FORCE;

            const currentVel = rigidBody.current.linvel();
            rigidBody.current.setLinvel({ x: currentVel.x, y: jumpVelocity, z: currentVel.z }, true);

            inAir.current = true;
            setTimeout(() => { inAir.current = false; }, 500);
          }
        }
      }
    );

    const unsubscribeCrouch = sub(
      (state) => state.toggleMode,
      (pressed) => {
        if (pressed) setIsCrouching((prev) => !prev);
      }
    );

    return () => {
      unsubscribeJump();
      unsubscribeCrouch();
    };
  }, [sub, world, rapier]);

  useFrame(() => {
    if (!rigidBody.current) return;

    const { forward, backward, left, right } = get();
    const velocity = rigidBody.current.linvel();

    const currentPos = rigidBody.current.translation();

    if (!isLiveRef.current && posDebugRef.current) {
      posDebugRef.current.innerText = `X: ${currentPos.x.toFixed(1)}\nY: ${currentPos.y.toFixed(1)}\nZ: ${currentPos.z.toFixed(1)}`;
    }

    if (currentPos.y < -10) {
      rigidBody.current.setTranslation(
        { x: START_POSITION[0], y: START_POSITION[1], z: START_POSITION[2] },
        true
      );
      rigidBody.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
      inAir.current = false;
    }

    const direction = new Vector3(0, 0, 0);
    if (forward) { direction.x -= 1; direction.z -= 1; }
    if (backward) { direction.x += 1; direction.z += 1; }
    if (left) { direction.x -= 1; direction.z += 1; }
    if (right) { direction.x += 1; direction.z -= 1; }

    const isMoving = direction.length() > 0;
    isMovingRef.current = isMoving;

    let isGrounded = false;
    if (!inAir.current) {
      const rayOrigin = { x: currentPos.x, y: currentPos.y + 0.05, z: currentPos.z };
      const rayDir = { x: 0, y: -1, z: 0 };
      const ray = new rapier.Ray(rayOrigin, rayDir);
      const hit = world.castRay(ray, 0.2, true, 0xffffffff, null, rigidBody.current);
      isGrounded = hit !== null;
    }

    let nextAnimation = "Idle";
    let currentSpeed = 0;

    if (inAir.current || !isGrounded) {
      if (animation === "Dash") {
        nextAnimation = "Dash";
      } else if (animation === "Jump") {
        nextAnimation = "Jump";
      } else {
        if (inAir.current && isMoving && !isCrouching) {
          nextAnimation = "Dash";
        } else {
          nextAnimation = "Jump";
        }
      }

      if (isMoving) {
        if (nextAnimation === "Dash") {
          currentSpeed = DASH_SPEED;
        } else {
          currentSpeed = AIR_SPEED;
        }

        direction.normalize();
        const rotation = Math.atan2(direction.x, direction.z);
        if (rotationGroup.current) {
          rotationGroup.current.rotation.y = rotation;
        }
      } else {
        currentSpeed = 0;
      }
    } else if (isMoving) {
      nextAnimation = isCrouching ? "Walk" : "Run";
      currentSpeed = isCrouching ? WALK_SPEED : RUN_SPEED;

      direction.normalize();
      const rotation = Math.atan2(direction.x, direction.z);
      if (rotationGroup.current) {
        rotationGroup.current.rotation.y = rotation;
      }
    } else {
      nextAnimation = isCrouching ? "Crouch" : "Idle";
      currentSpeed = 0;
    }

    if (animation !== nextAnimation) {
      setAnimation(nextAnimation);
    }

    rigidBody.current.setLinvel(
      {
        x: direction.x * currentSpeed,
        y: velocity.y,
        z: direction.z * currentSpeed
      },
      true
    );

    if (isLiveRef.current) {
      const dist = BASE_DISTANCE;
      const isoVec = 0.57735;

      camera.position.set(
        currentPos.x + dist * isoVec,
        currentPos.y + dist * isoVec,
        currentPos.z + dist * isoVec
      );

      camera.lookAt(currentPos.x, currentPos.y, currentPos.z);
      camera.zoom = BASE_ZOOM;
      camera.updateProjectionMatrix();

    } else {
      if (orbitControlsRef.current) {
        orbitControlsRef.current.target.set(currentPos.x, currentPos.y, currentPos.z);
        orbitControlsRef.current.update();
      }
    }
  });

  return (
    <>
      <RigidBody
        ref={rigidBody}
        position={START_POSITION}
        enabledRotations={[false, false, false]}
        colliders={false}
        friction={0.0}
        gravityScale={2.6}
        ccd
        mass={1}
      >
        <BallCollider args={[0.3]} position={[0, 0.3, 0]} friction={0} />
        <CapsuleCollider
          args={isCrouching ? [0.025, 0.58] : [0.3, 0.4]}
          position={isCrouching ? [0, 0.7, 0] : [0, 0.8, 0]}
        />

        {!isLive && (
          <Html position={[0, 2.5, 0]} center>
            <div
              ref={posDebugRef}
              style={{
                fontFamily: 'monospace',
                fontSize: '12px',
                color: '#00ff00',
                background: 'rgba(0,0,0,0.7)',
                padding: '4px 8px',
                borderRadius: '4px',
                whiteSpace: 'pre',
                pointerEvents: 'none',
                userSelect: 'none'
              }}
            >
              Loading...
            </div>
          </Html>
        )}

        <group ref={rotationGroup}>
          <group scale={0.8} position={[0, 0, 0]}>
            <PlayerVisuals
              scene={scene}
              animations={animations}
              currentAnimation={animation}
              isGhost={false}
            />
          </group>
          <group scale={0.8} position={[0, 0, 0]}>
            <PlayerVisuals
              scene={ghostScene}
              animations={animations}
              currentAnimation={animation}
              isGhost={true}
            />
          </group>
        </group>
      </RigidBody>
    </>
  );
};

const Level = () => {
  const { scene } = useGLTF('/models/level_test.glb');

  useEffect(() => {
    scene.traverse((child: any) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.name.includes('InvisibleWall')) {
          child.visible = false;
        }
      }
    });
  }, [scene]);

  return (
    <group>
      <RigidBody type="fixed" colliders="trimesh" friction={1}>
        <primitive object={scene} />
      </RigidBody>

      <Enemy path={[
        new Vector3(-11, 1, 20),
        new Vector3(-8.5, 1, 15.2),
        new Vector3(-4.2, 1, 16),
        new Vector3(-6, 1, 24)
      ]} />

      <Enemy path={[
        new Vector3(-12, 5, 18),
        new Vector3(-20, 5, 18)
      ]} />
    </group>
  );
};

export default function App() {
  const { isLiveMode, showPhysics } = useControls({
    isLiveMode: {
      value: false,
      label: 'Live Mode',
    },
    showPhysics: {
      value: false,
      label: 'Show Physics'
    }
  });

  const isLive = isLiveMode;

  const orbitControlsRef = useRef<any>(null);

  useEffect(() => {
    const restoreFocus = () => {
      window.focus();
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    };

    restoreFocus();
    const timer = setTimeout(restoreFocus, 100);
    return () => clearTimeout(timer);
  }, [isLiveMode]);

  return (
    <KeyboardControls map={keyboardMap}>
      <Canvas
        shadows
        onPointerDown={() => {
          window.focus();
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        }}
      >
        <fogExp2 attach="fog" args={['#503857', 0.0128]} />
        <ambientLight intensity={0.54} color="#e8aa81" />
        <directionalLight
          position={[50, 35, 15]}
          intensity={1.8}
          castShadow
          shadow-mapSize={[2048, 2048]}
        >
          <orthographicCamera attach="shadow-camera" args={[-50, 50, 50, -50]} />
        </directionalLight>

        <OrthographicCamera
          makeDefault
          position={[
            START_POSITION[0] + 20,
            START_POSITION[1] + 20,
            START_POSITION[2] + 20
          ]}
          zoom={40}
          near={0.1}
          far={1000}
          onUpdate={c => {
            if (!isLive) c.lookAt(START_POSITION[0], START_POSITION[1], START_POSITION[2])
          }}
        />

        {!isLive && (
          <OrbitControls
            ref={orbitControlsRef}
            target={new Vector3(...START_POSITION)}
            enableZoom={true}
            enableRotate={true}
            maxPolarAngle={Math.PI / 2.1}
          />
        )}

        <Physics debug={!isLive && showPhysics}>
          <Suspense fallback={null}>
            <Level />
            <Player isLive={isLive} orbitControlsRef={orbitControlsRef} />
          </Suspense>
        </Physics>

        <color attach="background" args={['#200a0a']} />
      </Canvas>
    </KeyboardControls>
  );
}